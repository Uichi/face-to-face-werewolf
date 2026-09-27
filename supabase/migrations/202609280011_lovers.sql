-- Add a pair of village-side lovers. Requires points migration 010.
-- Rerunnable; existing roles, scores and rooms remain intact.
begin;
alter table app_private.rooms alter column victory_points set default '{"villager":5,"wolf":6,"seer":5,"medium":5,"knight":5,"madman":6,"lover":5}'::jsonb;
update app_private.rooms set victory_points='{"lover":5}'::jsonb||victory_points where not victory_points ? 'lover';
create or replace function app_private.default_composition(n integer) returns jsonb
language sql immutable set search_path = '' as $$
  select case n
    when 5 then '{"villager":3,"wolf":1,"seer":1,"medium":0,"knight":0,"madman":0,"lover":0}'::jsonb
    when 6 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":0,"madman":0,"lover":0}'::jsonb
    when 7 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":1,"madman":0,"lover":0}'::jsonb
    when 8 then '{"villager":2,"wolf":2,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    when 9 then '{"villager":3,"wolf":2,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    when 10 then '{"villager":4,"wolf":2,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    when 11 then '{"villager":5,"wolf":2,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    when 12 then '{"villager":5,"wolf":3,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    when 13 then '{"villager":6,"wolf":3,"seer":1,"medium":1,"knight":1,"madman":1,"lover":0}'::jsonb
    else null end;
$$;

create or replace function app_private.game_kill(g jsonb, target text, reason text) returns jsonb
language plpgsql set search_path = '' as $$
declare victim jsonb; medium_id text; followed jsonb:='[]'::jsonb; event jsonb;
begin
 select p into victim from jsonb_array_elements(g->'players') p where p->>'id'=target and (p->>'alive')::boolean;
 if victim is null then raise exception '脱落対象が生存していません。'; end if;
 if victim->>'role'='lover' then
   select coalesce(jsonb_agg(p->'id'),'[]'::jsonb) into followed from jsonb_array_elements(g->'players') p where p->>'role'='lover' and p->>'id'<>target and (p->>'alive')::boolean;
 end if;
 g:=jsonb_set(g,'{players}',(select jsonb_agg(case when p->>'id'=target or followed ? (p->>'id') then p||'{"alive":false}'::jsonb else p end) from jsonb_array_elements(g->'players') p));
 if reason='execution' then
   select p->>'id' into medium_id from jsonb_array_elements(g->'players') p where p->>'role'='medium' and (p->>'alive')::boolean;
   if medium_id is not null then
     g:=jsonb_set(g,'{secrets}',(g->'secrets')||jsonb_build_array(jsonb_build_object('recipientId',medium_id,'targetId',target,'isWolf',victim->>'role'='wolf','kind','medium','day',g->'day')));
   end if;
 end if;
 event:=jsonb_build_object('playerId',target,'cause',reason,'day',g->'day');
 if jsonb_array_length(followed)>0 then event:=event||jsonb_build_object('followedIds',followed); end if;
 return g||jsonb_build_object('lastElimination',event);
end;
$$;
revoke all on function app_private.game_kill(jsonb,text,text),app_private.default_composition(integer) from public,anon,authenticated;

create or replace function app_private.validate_victory_points(points jsonb) returns void
language plpgsql set search_path = '' as $$
declare role text;
begin
 if jsonb_typeof(points) is distinct from 'object' then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
 if (select count(*) from jsonb_object_keys(points))<>7 then raise exception '7役職の勝利点を設定してください。'; end if;
 foreach role in array array['villager','wolf','seer','medium','knight','madman','lover'] loop
   if jsonb_typeof(points->role) is distinct from 'number' or coalesce(points->>role,'') !~ '^(10|[0-9])$' then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
 end loop;
end;
$$;

create or replace function app_private.score_record(g jsonb, player_id text, kind text, discovered_id text default null) returns jsonb
language plpgsql set search_path = '' as $$
declare stats jsonb;
begin
 if not g ? 'scoring' then return g; end if;
 stats:=coalesce(g->'scoring'->'stats'->player_id,'{"survival":0,"contribution":0,"discovered":[]}'::jsonb);
 if discovered_id is not null then
   if stats->'discovered' ? discovered_id then return g; end if;
   stats:=jsonb_set(stats,'{discovered}',(stats->'discovered')||jsonb_build_array(discovered_id));
 end if;
 stats:=jsonb_set(stats,array[kind],to_jsonb(least(3,(stats->>kind)::integer+1)));
 return jsonb_set(g,array['scoring','stats',player_id],stats);
end;
$$;

-- Called only under the room lock by game_command, in the same transaction as the game write.
create or replace function app_private.score_award(room uuid, g jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare p jsonb; stats jsonb; won boolean; victory integer; survival integer; contribution integer; scores jsonb:='[]'::jsonb;
begin
 if g->>'phase'<>'finished' or not g ? 'scoring' or g ? 'scores' then return g; end if;
 for p in select value from jsonb_array_elements(g->'players') loop
   won:=(case when p->>'role' in ('wolf','madman') then 'wolves' else 'village' end)=g->>'winner';
   stats:=g->'scoring'->'stats'->(p->>'id');
   victory:=case when won then (g->'scoring'->'victoryPoints'->>(p->>'role'))::integer else 0 end;
   survival:=coalesce((stats->>'survival')::integer,0);
   contribution:=case when won then coalesce((stats->>'contribution')::integer,0) else 0 end;
   update app_private.members set points=points+victory+survival+contribution where room_id=room and id=(p->>'id')::uuid;
   scores:=scores||jsonb_build_array(jsonb_build_object('playerId',p->>'id','victory',victory,'survival',survival,'contribution',contribution,'total',victory+survival+contribution));
 end loop;
 return g||jsonb_build_object('scores',scores);
end;
$$;

create or replace function public.score_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r app_private.rooms%rowtype; me app_private.members%rowtype;
begin
 if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
 if action is distinct from 'reset' or jsonb_typeof(payload) is distinct from 'object' then raise exception '操作が不正です。'; end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then raise exception 'この部屋に参加していません。'; end if;
 if me.id<>r.host_id or r.status<>'waiting' then raise exception '待機中の主催者だけがリセットできます。'; end if;
 if (payload->>'revision')::bigint is distinct from r.revision then raise exception '部屋が更新されました。最新の内容を確認してください。'; end if;
 update app_private.members set points=0 where room_id=r.id;
 update app_private.rooms set revision=revision+1,updated_at=now() where id=r.id returning * into r;
 update public.room_updates set revision=r.revision where room_id=r.id;
 return app_private.snapshot(r.id);
end;
$$;

create or replace function app_private.snapshot(target uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'room', jsonb_build_object(
    'id', r.id, 'code', r.code, 'hostId', r.host_id, 'status', r.status,
    'revision', r.revision, 'discussionMinutes', r.discussion_minutes,
    'composition', coalesce('{"madman":0,"lover":0}'::jsonb || r.composition, app_private.default_composition((select count(*)::integer from app_private.members where room_id = r.id))),
    'loverRole',true,'customComposition', r.composition is not null, 'victoryPoints', r.victory_points,
    'viewerId', (select id from app_private.members where room_id = r.id and user_id = auth.uid()),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nickname', m.nickname, 'points', m.points,
      'connected', m.last_seen > now() - interval '30 seconds') order by m.seat), '[]'::jsonb)
      from app_private.members m where m.room_id = r.id)))
  from app_private.rooms r where r.id = target;
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
      comp := '{"madman":0,"lover":0}'::jsonb || comp;
      if (select count(*) from jsonb_object_keys(comp)) <> 7 then return jsonb_build_object('ok', false, 'message', '配役が不正です。'); end if;
      foreach key in array array['villager','wolf','seer','medium','knight','madman','lover'] loop
        if jsonb_typeof(comp->key) is distinct from 'number' or coalesce(comp->>key, '') !~ '^[0-9]{1,2}$' then return jsonb_build_object('ok', false, 'message', '配役は0以上の整数です。'); end if;
        amount := (comp->>key)::integer;
        if amount > 13 or (key in ('seer','medium','knight','madman') and amount > 1) then return jsonb_build_object('ok', false, 'message', '占い師・霊媒師・騎士・狂人は各0〜1人です。'); end if;
        total := total + amount;
      end loop;
      if (comp->>'lover')::integer not in (0,2) then return jsonb_build_object('ok',false,'message','恋人は0人か2人で設定してください。'); end if;
      wolves := (comp->>'wolf')::integer;
      select count(*) into amount from app_private.members where room_id = r.id;
      if amount < 5 or total <> amount or wolves < 1 or wolves >= total - wolves then
        return jsonb_build_object('ok', false, 'message', '配役合計を参加人数に合わせ、人狼を1人以上かつ人間（狂人を含む）より少なくしてください。');
      end if;
    end if;
    if payload ? 'victoryPoints' then
      payload:=jsonb_set(payload,'{victoryPoints}',jsonb_build_object('lover',r.victory_points->'lover')||(payload->'victoryPoints'));
      perform app_private.validate_victory_points(payload->'victoryPoints');
    end if;
    update app_private.rooms set discussion_minutes = minutes, composition = comp,
      victory_points = case when payload ? 'victoryPoints' then payload->'victoryPoints' else victory_points end where id = r.id;
    changed := true;
  end if;

  if changed then
    update app_private.rooms set revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    update public.room_updates set revision = r.revision where room_id = r.id;
  end if;
  return app_private.snapshot(r.id);
end;
$$;
create or replace function app_private.game_settle(g jsonb, at_ms bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare phase text:=g->>'phase'; done boolean; seer_id text; target text; guard_target text; leaders jsonb; counts jsonb; winner text; choices jsonb; is_wolf boolean; actor jsonb; target_role text; knight_id text;
begin
 if phase='finished' then return g; end if;
 select not exists(select 1 from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and not (g->'confirmed') ? (p->>'id')) into done;
 if phase='roles' and done then
   select p->>'id' into seer_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='seer';
   if seer_id is not null then
     select p->>'id' into target from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'<>'wolf' and p->>'id'<>seer_id order by gen_random_uuid() limit 1;
     g:=jsonb_set(g,'{secrets}',(g->'secrets')||jsonb_build_array(jsonb_build_object('recipientId',seer_id,'targetId',target,'isWolf',false,'kind','initial','day',1)));
   end if;
   return app_private.game_enter(g,'firstNight',at_ms);
 elsif phase='firstNight' and done then return app_private.game_enter(g,'discussion',at_ms);
 elsif phase='execution' and done then return app_private.game_enter(g||'{"victimId":null}'::jsonb,'night',at_ms);
 elsif phase='morning' and done then return app_private.game_enter(g||'{"voteResult":null}'::jsonb,'discussion',at_ms);
 elsif phase='discussion' and at_ms >= (g->>'deadline')::bigint then return app_private.game_enter(g,'vote',at_ms);
 elsif phase in ('vote','runoff') and done then
   select jsonb_object_agg(id,n) into counts from (
     select p->>'id' id, (select count(*) from jsonb_each_text(g->'selections') c where c.value=p->>'id') n
     from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and (phase='vote' or (g->'runoffIds') ? (p->>'id'))
   ) votes;
   select jsonb_agg(key order by key) into leaders from jsonb_each_text(counts) c where c.value::integer=(select max(value::integer) from jsonb_each_text(counts));
   target:=case when jsonb_array_length(leaders)=1 then leaders->>0 else null end;
   g:=jsonb_set(g,'{voteResult}',jsonb_build_object('counts',counts,'executedId',target,'runoffIds',case when target is null and phase='vote' then leaders else '[]'::jsonb end));
   if target is null and phase='vote' then
     g:=app_private.game_enter(g,'runoff',at_ms); return jsonb_set(g,'{runoffIds}',leaders);
   end if;
   if target is not null then
     select p->>'role' into target_role from jsonb_array_elements(g->'players') p where p->>'id'=target;
     for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean loop
       if g->'selections'->>(actor->>'id')=target and
         ((actor->>'role' not in ('wolf','madman') and target_role='wolf') or
          (actor->>'role' in ('wolf','madman') and target_role not in ('wolf','madman'))) then
         g:=app_private.score_record(g,actor->>'id','contribution');
       end if;
     end loop;
     g:=app_private.game_kill(g,target,'execution');
   end if;
   winner:=app_private.game_winner(g);
   if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms); end if;
   return app_private.game_enter(g,'execution',at_ms);
 elsif phase='night' and done then
   -- Different wolves selecting the same person do not weight the random draw.
   select jsonb_agg(id) into choices from (select distinct g->'selections'->>(p->>'id') id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='wolf') candidates;
   select value into target from jsonb_array_elements_text(choices) order by gen_random_uuid() limit 1;
   select g->'selections'->>(p->>'id') into guard_target from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='knight';
   select p->>'id' into seer_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='seer';
   if seer_id is not null then
     select p->>'role'='wolf' into is_wolf from jsonb_array_elements(g->'players') p where p->>'id'=g->'selections'->>seer_id;
     g:=jsonb_set(g,'{secrets}',(g->'secrets')||jsonb_build_array(jsonb_build_object('recipientId',seer_id,'targetId',g->'selections'->>seer_id,'isWolf',is_wolf,'kind','seer','day',g->'day')));
   end if;
   if is_wolf then g:=app_private.score_record(g,seer_id,'contribution',g->'selections'->>seer_id); end if;
   if target is not null and target=guard_target then
     select p->>'id' into knight_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='knight';
     g:=app_private.score_record(g,knight_id,'contribution'); target:=null;
   end if;
   if target is not null then g:=app_private.game_kill(g,target,'attack'); end if;
   for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean loop
     g:=app_private.score_record(g,actor->>'id','survival');
   end loop;
   g:=g||jsonb_build_object('victimId',target,'day',(g->>'day')::integer+1);
   winner:=app_private.game_winner(g);
   if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms); end if;
   return app_private.game_enter(g,'morning',at_ms);
 end if;
 return g;
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
   comp:='{"madman":0,"lover":0}'::jsonb || coalesce(r.composition,app_private.default_composition(n));
   foreach role in array array['villager','wolf','seer','medium','knight','madman','lover'] loop
     if jsonb_typeof(comp->role) is distinct from 'number' or comp->>role !~ '^[0-9]{1,2}$' then raise exception '配役が不正です。'; end if;
     if (comp->>role)::integer>13 or (role in ('seer','medium','knight','madman') and (comp->>role)::integer>1) then raise exception '配役が不正です。'; end if;
     total:=total+(comp->>role)::integer;
     pool:=pool||array_fill(role,array[(comp->>role)::integer]);
   end loop;
   if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
   wolves:=(comp->>'wolf')::integer;
   if total<>n or wolves<1 or wolves>=n-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
   select array_agg(value order by gen_random_uuid()) into pool from unnest(pool) value;
   for member in select id from app_private.members where room_id=r.id order by seat loop
     idx:=idx+1; players:=players||jsonb_build_array(jsonb_build_object('id',member.id,'role',pool[idx],'alive',true));
   end loop;
   g:=jsonb_build_object('id',gen_random_uuid(),'startRequest',start_request,'hostId',r.host_id,'players',players,'phase','roles','phaseId',1,'day',1,
    'discussionMs',r.discussion_minutes*60000,'deadline',null,'selections','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,
    'voteResult',null,'victimId',null,'winner',null,'secrets','[]'::jsonb,'removals','[]'::jsonb,'receipts','{}'::jsonb);
   g:=g||jsonb_build_object('scoring',jsonb_build_object('victoryPoints',r.victory_points,'stats','{}'::jsonb));
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
       g:=app_private.score_award(r.id,g);
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
       if phase not in ('roles','firstNight','vote','runoff','night','execution','morning') then raise exception '確認する段階ではありません。'; end if;
       if (phase in ('vote','runoff') or (phase='night' and p->>'role' in ('wolf','seer','knight'))) and not (g->'selections') ? me.id::text then raise exception '先に対象を選んでください。'; end if;
       if not (g->'confirmed') ? me.id::text then g:=jsonb_set(g,'{confirmed}',(g->'confirmed')||jsonb_build_array(me.id)); end if;
     elsif action='next' then
       raise exception '結果は生存者全員の確認で進みます。';
     elsif action='startVote' then
       if phase<>'discussion' then raise exception '議論中ではありません。'; end if;
       g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,'vote',at_ms);
     elsif action='extend' then
       if phase not in ('discussion','vote','runoff','night') then raise exception '延長できる段階ではありません。'; end if;
       g:=jsonb_set(g,'{deadline}',to_jsonb(greatest(at_ms,(g->>'deadline')::bigint)+60000));
     elsif action='remove' then
       g:=app_private.game_kill(g,payload->>'targetId','disconnect');
       g:=jsonb_set(g,'{removals}',(g->'removals')||(select jsonb_agg(jsonb_build_object('playerId',id,'day',g->'day')) from jsonb_array_elements_text(jsonb_build_array(payload->>'targetId')||coalesce(g->'lastElimination'->'followedIds','[]'::jsonb)) id));
       winner:=app_private.game_winner(g);
       if winner is not null then g:=app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);
       elsif phase in ('vote','runoff','night') then
         g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,case when phase='night' then 'night' else 'vote' end,at_ms);
       else
         g:=g||jsonb_build_object('phaseId',(g->>'phaseId')::integer+1,'confirmed',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(g->'confirmed') confirmed where exists(select 1 from jsonb_array_elements(g->'players') living where living->>'id'=confirmed.value#>>'{}' and (living->>'alive')::boolean)));
       end if;
     end if;
     g:=jsonb_set(g,array['receipts',receipt],fingerprint);
     g:=app_private.game_settle(g,at_ms);
   end if;
 end if;
 g:=app_private.score_award(r.id,g);
 if g is distinct from original or created then
   insert into app_private.games values(r.id,g) on conflict(room_id) do update set state=excluded.state;
   update app_private.rooms set revision=revision+1,updated_at=now(),status=case when g->>'phase'='finished' then 'finished' else 'playing' end where id=r.id returning * into r;
   update public.room_updates set revision=r.revision where room_id=r.id;
 end if;
 return app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms);
end;
$$;
create or replace function app_private.game_view(g jsonb, viewer text) returns jsonb
language plpgsql set search_path = '' as $$
declare me jsonb; pub jsonb; priv jsonb; wolves jsonb;
begin
 select p into me from jsonb_array_elements(g->'players') p where p->>'id'=viewer;
 if me is null then raise exception '参加者ではありません。'; end if;
 pub:=jsonb_build_object('resultConfirmation',true,'id',g->'id','hostId',g->'hostId','phase',g->'phase','phaseId',g->'phaseId','day',g->'day','deadline',g->'deadline','winner',g->'winner',
  'scores',case when g->>'phase'='finished' then g->'scores' else null end,
  'followedIds',case when (g->>'phase'='execution' and g->'voteResult'->>'executedId'=g->'lastElimination'->>'playerId' and g->'lastElimination'->>'cause'='execution') or (g->>'phase'='morning' and g->>'victimId' is not null and g->'lastElimination'->>'cause'='attack') then coalesce(g->'lastElimination'->'followedIds','[]'::jsonb) else '[]'::jsonb end,
  'ending',case when g->>'phase'='finished' then g->'lastElimination' else null end,
  'runoffIds',g->'runoffIds','voteResult',g->'voteResult','victimId',g->'victimId','removals',g->'removals',
  'players',(select jsonb_agg(case when g->>'phase'='finished' then p else p-'role' end) from jsonb_array_elements(g->'players') p),
  'composition',(select jsonb_object_agg(role,n) from (select role,(select count(*) from jsonb_array_elements(g->'players') p where p->>'role'=role) n from unnest(array['villager','wolf','seer','medium','knight','madman','lover']) role) counts),
  'requiredCount',(select count(*) from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean),
  'completedCount',(select count(*) from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and (g->'confirmed') ? (p->>'id')));
 if (me->>'alive')::boolean and g->>'phase'<>'finished' then
   priv:=jsonb_build_object('role',me->'role','loverId',case when me->>'role'='lover' then (select p->>'id' from jsonb_array_elements(g->'players') p where p->>'role'='lover' and p->>'id'<>viewer limit 1) else null end,'confirmed',(g->'confirmed') ? viewer,'selection',g->'selections'->viewer,
     'results',(select coalesce(jsonb_agg(s),'[]'::jsonb) from jsonb_array_elements(g->'secrets') s where s->>'recipientId'=viewer));
   if me->>'role'='wolf' then
     wolves:=jsonb_build_object('memberIds',(select jsonb_agg(p->'id') from jsonb_array_elements(g->'players') p where p->>'role'='wolf'),
       'selections',case when g->>'phase'='night' then (select jsonb_agg(jsonb_build_object('actorId',p->'id','targetId',g->'selections'->(p->>'id'))) from jsonb_array_elements(g->'players') p where p->>'role'='wolf' and (p->>'alive')::boolean) else '[]'::jsonb end);
   end if;
 end if;
 return jsonb_build_object('public',pub,'private',priv,'wolves',wolves);
end;
$$;


revoke all on function app_private.validate_victory_points(jsonb),app_private.score_record(jsonb,text,text,text),app_private.score_award(uuid,jsonb),app_private.snapshot(uuid),app_private.game_view(jsonb,text),app_private.game_settle(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.score_command(text,jsonb),public.lobby_command(text,jsonb),public.game_command(text,jsonb) from public,anon;
grant execute on function public.score_command(text,jsonb),public.lobby_command(text,jsonb),public.game_command(text,jsonb) to authenticated;
commit;
