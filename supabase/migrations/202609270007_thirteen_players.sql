-- Raise the room and game limit to 13; keep existing members and games intact.
-- Run the entire file in SQL Editor. Rerunnable; requires lobby and game setup.
begin;
create or replace function app_private.default_composition(n integer) returns jsonb
language sql immutable set search_path = '' as $$
  select case n
    when 5 then '{"villager":3,"wolf":1,"seer":1,"medium":0,"knight":0}'::jsonb
    when 6 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":0}'::jsonb
    when 7 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":1}'::jsonb
    when 8 then '{"villager":3,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 9 then '{"villager":4,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 10 then '{"villager":5,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 11 then '{"villager":6,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 12 then '{"villager":6,"wolf":3,"seer":1,"medium":1,"knight":1}'::jsonb
    when 13 then '{"villager":7,"wolf":3,"seer":1,"medium":1,"knight":1}'::jsonb
    else null end;
$$;

create or replace function public.lobby_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); r app_private.rooms%rowtype; me app_private.members%rowtype;
  name text; code_in text; candidate uuid; amount integer; minutes integer;
  comp jsonb; key text; total integer := 0; wolves integer; changed boolean := false;
begin
  if uid is null then raise exception 'ログインが必要です'; end if;
  if action not in ('create', 'join', 'get', 'heartbeat', 'settings') then raise exception '操作が不正です'; end if;
  if jsonb_typeof(payload) <> 'object' then raise exception '操作が不正です'; end if;
  -- Serialize requests made by the same anonymous identity, including create retries.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  if action in ('create', 'join') then
    name := btrim(regexp_replace(normalize(coalesce(payload->>'nickname', ''), NFKC), '\s+', ' ', 'g'));
    if char_length(name) not between 1 and 20 or name ~ '[[:cntrl:]]' then
      return jsonb_build_object('ok', false, 'message', '名前は1〜20文字で入力してください。');
    end if;
  end if;

  if action = 'create' then
    select * into r from app_private.rooms where created_by = uid and create_request = (payload->>'requestId')::uuid;
    if found then
      if r.updated_at <= now() - interval '24 hours' then
        return jsonb_build_object('ok', false, 'message', 'この部屋の有効期限が切れました。');
      end if;
      if not exists(select 1 from app_private.members where room_id=r.id and user_id=uid) then
        return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', 'この部屋から退出しています。招待コードで参加し直してください。');
      end if;
      return app_private.snapshot(r.id);
    end if;
    if not app_private.allow_attempt('create', 3, interval '1 hour') then
      return jsonb_build_object('ok', false, 'message', '部屋の作成回数が多いため、しばらく待ってください。');
    end if;
    -- 40 random bits, with collision retry. Joining is separately rate-limited.
    loop
      begin
        insert into app_private.rooms(code, created_by, create_request)
          values(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), uid, (payload->>'requestId')::uuid)
          returning * into r;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    insert into app_private.members(room_id, user_id, nickname, nickname_key) values(r.id, uid, name, lower(name)) returning * into me;
    update app_private.rooms set host_id = me.id where id = r.id;
    insert into public.room_updates values(r.id, r.revision);
    return app_private.snapshot(r.id);
  end if;

  if action = 'join' then
    if not app_private.allow_attempt('join', 20, interval '10 minutes') then
      return jsonb_build_object('ok', false, 'message', '参加の試行が多いため、しばらく待ってください。');
    end if;
    code_in := upper(regexp_replace(coalesce(payload->>'code', ''), '[\s-]', '', 'g'));
    select * into r from app_private.rooms where code = code_in and updated_at > now() - interval '24 hours' for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
    select * into me from app_private.members where room_id = r.id and user_id = uid;
    if found then
      update app_private.members set last_seen = now() where id = me.id;
      return app_private.snapshot(r.id);
    end if;
    if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'message', '開始後の部屋には参加できません。'); end if;
    select count(*) into amount from app_private.members where room_id = r.id;
    if amount >= 13 then return jsonb_build_object('ok', false, 'message', 'この部屋は満員です。'); end if;
    if exists(select 1 from app_private.members where room_id = r.id and nickname_key = lower(name)) then
      return jsonb_build_object('ok', false, 'message', '同じ名前の人がいます。別の名前にしてください。');
    end if;
    insert into app_private.members(room_id, user_id, nickname, nickname_key) values(r.id, uid, name, lower(name)) returning * into me;
    changed := true;
  else
    select * into r from app_private.rooms where id = (payload->>'roomId')::uuid and updated_at > now() - interval '24 hours' for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
    select * into me from app_private.members where room_id = r.id and user_id = uid;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', 'この部屋の参加者から外れました。招待コードから参加し直せます。'); end if;
  end if;

  if action = 'heartbeat' then
    update app_private.members set last_seen = now() where id = me.id;
    if exists(select 1 from app_private.members where id = r.host_id and last_seen <= now() - interval '60 seconds') then
      select id into candidate from app_private.members where room_id = r.id and last_seen > now() - interval '30 seconds' order by seat limit 1;
      if candidate is not null and candidate <> r.host_id then
        update app_private.rooms set host_id = candidate where id = r.id;
        changed := true;
      end if;
    end if;
  end if;

  if action = 'settings' then
    if r.host_id <> me.id or r.status <> 'waiting' then
      return jsonb_build_object('ok', false, 'message', '待機中の主催者だけが設定を変更できます。');
    end if;
    if (payload->>'revision')::bigint is distinct from r.revision then
      return jsonb_build_object('ok', false, 'message', '参加者や設定が更新されました。最新の内容を確認してください。');
    end if;
    if coalesce(payload->>'discussionMinutes', '') !~ '^[0-9]{1,2}$' then
      return jsonb_build_object('ok', false, 'message', '議論時間は1〜10分です。');
    end if;
    minutes := (payload->>'discussionMinutes')::integer;
    if minutes not between 1 and 10 then return jsonb_build_object('ok', false, 'message', '議論時間は1〜10分です。'); end if;
    comp := nullif(payload->'composition', 'null'::jsonb);
    if comp is not null then
      if jsonb_typeof(comp) <> 'object' then return jsonb_build_object('ok', false, 'message', '配役が不正です。'); end if;
      if (select count(*) from jsonb_object_keys(comp)) <> 5 then return jsonb_build_object('ok', false, 'message', '配役が不正です。'); end if;
      foreach key in array array['villager','wolf','seer','medium','knight'] loop
        if jsonb_typeof(comp->key) is distinct from 'number' or coalesce(comp->>key, '') !~ '^[0-9]{1,2}$' then return jsonb_build_object('ok', false, 'message', '配役は0以上の整数です。'); end if;
        amount := (comp->>key)::integer;
        if amount > 13 or (key in ('seer','medium','knight') and amount > 1) then return jsonb_build_object('ok', false, 'message', '能力職は各0〜1人です。'); end if;
        total := total + amount;
      end loop;
      wolves := (comp->>'wolf')::integer;
      select count(*) into amount from app_private.members where room_id = r.id;
      if amount < 5 or total <> amount or wolves < 1 or wolves >= total - wolves then
        return jsonb_build_object('ok', false, 'message', '配役合計を参加人数に合わせ、人狼を1人以上かつ村側より少なくしてください。');
      end if;
    end if;
    update app_private.rooms set discussion_minutes = minutes, composition = comp where id = r.id;
    changed := true;
  end if;

  if changed then
    update app_private.rooms set revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    update public.room_updates set revision = r.revision where room_id = r.id;
  end if;
  return app_private.snapshot(r.id);
end;
$$;
create or replace function public.game_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 r app_private.rooms%rowtype; me app_private.members%rowtype; g jsonb; original jsonb; p jsonb; target jsonb;
 at_ms bigint; comp jsonb; role text; pool text[]:=array[]::text[]; players jsonb:='[]'::jsonb;
 member record; n integer; total integer:=0; wolves integer; idx integer:=0; phase text; winner text;
 receipt text; fingerprint jsonb; created boolean:=false; start_request text;
begin
 if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
 if action is null or action not in ('start','get','select','confirm','next','startVote','extend','remove','rematch') then raise exception '操作が不正です。'; end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception '操作が不正です。'; end if;
 -- Every operation locks the room first, matching the lobby lock order.
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then raise exception 'この部屋に参加していません。'; end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not app_private.allow_attempt('game',240,interval '1 minute') then return jsonb_build_object('ok',false,'message','操作が多いため、少し待ってください。'); end if;
 select state into g from app_private.games where room_id=r.id;
 original:=g;
 if action='start' then
   if r.host_id<>me.id then raise exception '主催者のみ開始できます。'; end if;
   start_request:=(payload->>'requestId')::uuid::text;
   if start_request is null then raise exception '操作IDが必要です。'; end if;
   if r.status<>'waiting' then
     if g->>'startRequest'=start_request then
       return app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms);
     end if;
     raise exception 'すでにゲームが始まっています。';
   end if;
   if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が変わりました。内容を確認してもう一度開始してください。'; end if;
   select count(*) into n from app_private.members where room_id=r.id;
   if n not between 5 and 13 then raise exception '開始には5〜13人必要です。'; end if;
   comp:=coalesce(r.composition,app_private.default_composition(n));
   foreach role in array array['villager','wolf','seer','medium','knight'] loop
     if jsonb_typeof(comp->role) is distinct from 'number' or comp->>role !~ '^[0-9]{1,2}$' then raise exception '配役が不正です。'; end if;
     if (comp->>role)::integer>13 or (role in ('seer','medium','knight') and (comp->>role)::integer>1) then raise exception '配役が不正です。'; end if;
     total:=total+(comp->>role)::integer;
     pool:=pool||array_fill(role,array[(comp->>role)::integer]);
   end loop;
   wolves:=(comp->>'wolf')::integer;
   if total<>n or wolves<1 or wolves>=n-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
   select array_agg(value order by gen_random_uuid()) into pool from unnest(pool) value;
   for member in select id from app_private.members where room_id=r.id order by seat loop
     idx:=idx+1; players:=players||jsonb_build_array(jsonb_build_object('id',member.id,'role',pool[idx],'alive',true));
   end loop;
   g:=jsonb_build_object('id',gen_random_uuid(),'startRequest',start_request,'hostId',r.host_id,'players',players,'phase','roles','phaseId',1,'day',1,
    'discussionMs',r.discussion_minutes*60000,'deadline',null,'selections','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,
    'voteResult',null,'victimId',null,'winner',null,'secrets','[]'::jsonb,'removals','[]'::jsonb,'receipts','{}'::jsonb);
   update app_private.rooms set status='playing' where id=r.id;
   created:=true;
 elsif r.status='waiting' then
   if action<>'get' then raise exception '待機室に戻っています。'; end if;
   return app_private.snapshot(r.id)||jsonb_build_object('game',null,'serverNow',at_ms);
 else
   if g is null then raise exception '試合が見つかりません。'; end if;
   g:=g||jsonb_build_object('hostId',r.host_id);
   if action<>'get' then
     if payload->>'gameId' is distinct from g->>'id' then raise exception '別の試合の操作です。画面を更新してください。'; end if;
     if payload->>'requestId' is null then raise exception '操作IDが必要です。'; end if;
     receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;
     fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId','targetId',payload->'targetId');
     if g->'receipts' ? receipt then
       if g->'receipts'->receipt<>fingerprint then raise exception '同じ操作IDの内容が異なります。'; end if;
       return app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms);
     end if;
   end if;
   -- A server clock check on every read also recovers a missed realtime notification.
   g:=app_private.game_settle(g,at_ms);
   if action<>'get' then
     if (payload->>'phaseId')::integer is distinct from (g->>'phaseId')::integer then
       -- Keep an elapsed clock transition even when the arriving operation is stale.
       update app_private.games set state=g where room_id=r.id;
       update app_private.rooms set revision=revision+1,updated_at=now(),status=case when g->>'phase'='finished' then 'finished' else 'playing' end where id=r.id returning * into r;
       update public.room_updates set revision=r.revision where room_id=r.id;
       return jsonb_build_object('ok',false,'message','次の段階に進みました。最新の画面で操作してください。');
     end if;
     phase:=g->>'phase';
     select value into p from jsonb_array_elements(g->'players') where value->>'id'=me.id::text;
     if action in ('next','startVote','extend','remove','rematch') then
       if me.id<>r.host_id then raise exception '主催者のみ操作できます。'; end if;
     elsif not (p->>'alive')::boolean then raise exception '脱落者は操作できません。'; end if;
     if phase='finished' and action<>'rematch' then raise exception '試合は終了しています。'; end if;
     if action='rematch' then
       if phase<>'finished' then raise exception '終了後に再戦できます。'; end if;
       delete from app_private.games where room_id=r.id;
       update app_private.rooms set status='waiting',revision=revision+1,updated_at=now() where id=r.id returning * into r;
       update public.room_updates set revision=r.revision where room_id=r.id;
       return app_private.snapshot(r.id)||jsonb_build_object('game',null,'serverNow',at_ms);
     elsif action='select' then
       if phase not in ('vote','runoff','night') then raise exception '選択する段階ではありません。'; end if;
       if g->'confirmed' ? me.id::text then raise exception '確定済みです。'; end if;
       select value into target from jsonb_array_elements(g->'players') where value->>'id'=payload->>'targetId' and (value->>'alive')::boolean;
       if target is null or target->>'id'=me.id::text then raise exception '対象が不正です。'; end if;
       if phase='runoff' and not (g->'runoffIds') ? (target->>'id') then raise exception '決選候補ではありません。'; end if;
       if phase='night' then
         if p->>'role' not in ('wolf','seer','knight') then raise exception '選択する能力がありません。'; end if;
         if p->>'role'='wolf' and target->>'role'='wolf' then raise exception '人狼は襲撃できません。'; end if;
       end if;
       g:=jsonb_set(g,array['selections',me.id::text],target->'id');
     elsif action='confirm' then
       if phase not in ('roles','firstNight','vote','runoff','night') then raise exception '確認する段階ではありません。'; end if;
       if (phase in ('vote','runoff') or (phase='night' and p->>'role' in ('wolf','seer','knight'))) and not (g->'selections') ? me.id::text then raise exception '先に対象を選んでください。'; end if;
       if not (g->'confirmed') ? me.id::text then g:=jsonb_set(g,'{confirmed}',(g->'confirmed')||jsonb_build_array(me.id)); end if;
     elsif action='next' then
       if phase='execution' then g:=app_private.game_enter(g||'{"victimId":null}'::jsonb,'night',at_ms);
       elsif phase='morning' then g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,'discussion',at_ms);
       else raise exception '結果画面ではありません。'; end if;
     elsif action='startVote' then
       if phase<>'discussion' then raise exception '議論中ではありません。'; end if;
       g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,'vote',at_ms);
     elsif action='extend' then
       if phase not in ('discussion','vote','runoff','night') then raise exception '延長できる段階ではありません。'; end if;
       g:=jsonb_set(g,'{deadline}',to_jsonb(greatest(at_ms,(g->>'deadline')::bigint)+60000));
     elsif action='remove' then
       g:=app_private.game_kill(g,payload->>'targetId','disconnect');
       g:=jsonb_set(g,'{removals}',(g->'removals')||jsonb_build_array(jsonb_build_object('playerId',payload->>'targetId','day',g->'day')));
       winner:=app_private.game_winner(g);
       if winner is not null then g:=app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);
       elsif phase in ('vote','runoff','night') then
         g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,case when phase='night' then 'night' else 'vote' end,at_ms);
       else
         g:=g||jsonb_build_object('phaseId',(g->>'phaseId')::integer+1,'confirmed',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(g->'confirmed') where value#>>'{}'<>payload->>'targetId'));
       end if;
     end if;
     g:=jsonb_set(g,array['receipts',receipt],fingerprint);
     g:=app_private.game_settle(g,at_ms);
   end if;
 end if;
 if g is distinct from original or created then
   insert into app_private.games values(r.id,g) on conflict(room_id) do update set state=excluded.state;
   update app_private.rooms set revision=revision+1,updated_at=now(),status=case when g->>'phase'='finished' then 'finished' else 'playing' end where id=r.id returning * into r;
   update public.room_updates set revision=r.revision where room_id=r.id;
 end if;
 return app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms);
end;
$$;
revoke all on function app_private.default_composition(integer) from public,anon,authenticated;
revoke all on function public.lobby_command(text,jsonb),public.game_command(text,jsonb) from public,anon;
grant execute on function public.lobby_command(text,jsonb),public.game_command(text,jsonb) to authenticated;
commit;
