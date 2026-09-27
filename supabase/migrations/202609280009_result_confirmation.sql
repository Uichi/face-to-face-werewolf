-- Results advance after every living player confirms; dead hosts need not act.
-- Rerunnable. Existing games retain their state. Requires the madman update (008).
begin;
create or replace function app_private.game_settle(g jsonb, at_ms bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare phase text:=g->>'phase'; done boolean; seer_id text; target text; guard_target text; leaders jsonb; counts jsonb; winner text; choices jsonb; is_wolf boolean;
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
   if target is not null then g:=app_private.game_kill(g,target,'execution'); end if;
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
   if target is not distinct from guard_target then target:=null; end if;
   if target is not null then g:=app_private.game_kill(g,target,'attack'); end if;
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
   comp:='{"madman":0}'::jsonb || coalesce(r.composition,app_private.default_composition(n));
   foreach role in array array['villager','wolf','seer','medium','knight','madman'] loop
     if jsonb_typeof(comp->role) is distinct from 'number' or comp->>role !~ '^[0-9]{1,2}$' then raise exception '配役が不正です。'; end if;
     if (comp->>role)::integer>13 or (role in ('seer','medium','knight','madman') and (comp->>role)::integer>1) then raise exception '配役が不正です。'; end if;
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
create or replace function app_private.game_view(g jsonb, viewer text) returns jsonb
language plpgsql set search_path = '' as $$
declare me jsonb; pub jsonb; priv jsonb; wolves jsonb;
begin
 select p into me from jsonb_array_elements(g->'players') p where p->>'id'=viewer;
 if me is null then raise exception '参加者ではありません。'; end if;
 pub:=jsonb_build_object('resultConfirmation',true,'id',g->'id','hostId',g->'hostId','phase',g->'phase','phaseId',g->'phaseId','day',g->'day','deadline',g->'deadline','winner',g->'winner',
  'ending',case when g->>'phase'='finished' then g->'lastElimination' else null end,
  'runoffIds',g->'runoffIds','voteResult',g->'voteResult','victimId',g->'victimId','removals',g->'removals',
  'players',(select jsonb_agg(case when g->>'phase'='finished' then p else p-'role' end) from jsonb_array_elements(g->'players') p),
  'composition',(select jsonb_object_agg(role,n) from (select role,(select count(*) from jsonb_array_elements(g->'players') p where p->>'role'=role) n from unnest(array['villager','wolf','seer','medium','knight','madman']) role) counts),
  'requiredCount',(select count(*) from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean),
  'completedCount',(select count(*) from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and (g->'confirmed') ? (p->>'id')));
 if (me->>'alive')::boolean and g->>'phase'<>'finished' then
   priv:=jsonb_build_object('role',me->'role','confirmed',(g->'confirmed') ? viewer,'selection',g->'selections'->viewer,
     'results',(select coalesce(jsonb_agg(s),'[]'::jsonb) from jsonb_array_elements(g->'secrets') s where s->>'recipientId'=viewer));
   if me->>'role'='wolf' then
     wolves:=jsonb_build_object('memberIds',(select jsonb_agg(p->'id') from jsonb_array_elements(g->'players') p where p->>'role'='wolf'),
       'selections',case when g->>'phase'='night' then (select jsonb_agg(jsonb_build_object('actorId',p->'id','targetId',g->'selections'->(p->>'id'))) from jsonb_array_elements(g->'players') p where p->>'role'='wolf' and (p->>'alive')::boolean) else '[]'::jsonb end);
   end if;
 end if;
 return jsonb_build_object('public',pub,'private',priv,'wolves',wolves);
end;
$$;

revoke all on function app_private.game_view(jsonb,text) from public,anon,authenticated;
revoke all on function app_private.game_settle(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.game_command(text,jsonb) from public,anon;
grant execute on function public.game_command(text,jsonb) to authenticated;
commit;
