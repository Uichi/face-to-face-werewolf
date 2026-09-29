-- Add the Thief role and weighted, private wolf attack wishes.
-- Apply after 202609290015_public_log.sql. Rerunnable; existing games remain playable.
begin;

alter table app_private.rooms alter column victory_points set default
  '{"villager":5,"wolf":6,"seer":5,"medium":5,"knight":5,"madman":6,"lover":5,"baker":5,"thief":5}'::jsonb;
update app_private.rooms set victory_points=jsonb_build_object('thief',5)||victory_points where not victory_points ? 'thief';

create or replace function app_private.game_enter(g jsonb, phase text, at_ms bigint) returns jsonb
language sql immutable set search_path='' as $$
 select g||jsonb_build_object('phase',phase,'phaseId',(g->>'phaseId')::integer+1,
  'selections','{}'::jsonb,'attackStrengths','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,
  'deadline',case when phase='discussion' then at_ms+(g->>'discussionMs')::bigint when phase in ('vote','runoff','night') then at_ms+60000 else null end);
$$;

create or replace function app_private.validate_victory_points(points jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare role text;
begin
 if jsonb_typeof(points)<>'object' or (select count(*) from jsonb_object_keys(points))<>9 then raise exception '9役職の勝利点を設定してください。'; end if;
 foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief'] loop
  if jsonb_typeof(points->role) is distinct from 'number' or coalesce(points->>role,'') !~ '^(10|[0-9])$' then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
 end loop;
end; $$;

create or replace function app_private.thief_response(result jsonb,target_room uuid) returns jsonb
language sql stable set search_path='' as $$
 select case when result ? 'room' and result->'room' is not null then
  jsonb_set(jsonb_set(result,'{room,thiefRole}','true'::jsonb,true),'{room,composition}',
   case when result->'room'->'composition' is null then 'null'::jsonb else jsonb_build_object('thief',coalesce(result->'room'->'composition'->'thief','0'::jsonb))||(result->'room'->'composition') end,true)
 else result end;
$$;

create or replace function public.lobby_command_thief(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; r app_private.rooms%rowtype; me app_private.members%rowtype; comp jsonb; points jsonb; role text; amount integer; total integer:=0; wolves integer;
begin
 perform app_private.assert_site_access();
 if action<>'settings' then return app_private.thief_response(public.lobby_command_baker(action,payload),(payload->>'roomId')::uuid); end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found or me.id<>r.host_id or r.status<>'waiting' then raise exception '待機中の主催者だけが設定を変更できます。'; end if;
 if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が更新されました。最新の内容を確認してください。'; end if;
 if coalesce(payload->>'discussionMinutes','') !~ '^[0-9]{1,2}$' or (payload->>'discussionMinutes')::integer not between 1 and 10 then raise exception '議論時間は1〜10分です。'; end if;
 comp:=nullif(payload->'composition','null'::jsonb);
 if comp is not null then
  comp:='{"madman":0,"lover":0,"baker":0,"thief":0}'::jsonb||comp;
  if jsonb_typeof(comp)<>'object' or (select count(*) from jsonb_object_keys(comp))<>9 then raise exception '配役が不正です。'; end if;
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief'] loop
   if jsonb_typeof(comp->role) is distinct from 'number' or coalesce(comp->>role,'') !~ '^[0-9]{1,2}$' then raise exception '配役は0以上の整数です。'; end if;
   amount:=(comp->>role)::integer;
   if amount>13 or (role in ('seer','medium','knight','madman','baker','thief') and amount>1) then raise exception '能力職と怪盗は各0〜1人です。'; end if;
   total:=total+amount;
  end loop;
  if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
  select count(*) into amount from app_private.members where room_id=r.id; wolves:=(comp->>'wolf')::integer;
  if amount<5 or total<>amount or wolves<1 or wolves>=total-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
 end if;
 points:=jsonb_build_object('thief',coalesce(payload->'victoryPoints'->'thief',r.victory_points->'thief','5'::jsonb))||coalesce(payload->'victoryPoints',r.victory_points);
 perform app_private.validate_victory_points(points);
 update app_private.rooms set discussion_minutes=(payload->>'discussionMinutes')::integer,composition=comp,victory_points=points,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 update public.room_updates set revision=r.revision where room_id=r.id;
 return app_private.thief_response(app_private.snapshot(r.id),r.id);
end; $$;

create or replace function app_private.game_settle(g jsonb,at_ms bigint) returns jsonb
language plpgsql set search_path='' as $$
declare phase text:=g->>'phase'; done boolean; target text; leaders jsonb; counts jsonb; winner text; actor jsonb; target_role text; winning_choice text; thief_id text; stolen_role text; guard_target text; seer_id text; is_wolf boolean; knight_id text; max_weight integer;
begin
 if phase='finished' then return g; end if;
 select not exists(select 1 from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and not (g->'confirmed') ? (p->>'id')) into done;
 if phase='roles' and done then
  select p->>'id' into thief_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='thief';
  if thief_id is not null then
   target:=g->'selections'->>thief_id;
   select p->>'role' into stolen_role from jsonb_array_elements(g->'players') p where p->>'id'=target and (p->>'alive')::boolean and p->>'id'<>thief_id;
   if stolen_role is null then raise exception '怪盗の対象が不正です。'; end if;
   g:=jsonb_set(g,'{players}',(select jsonb_agg(case when p->>'id'=thief_id then p||jsonb_build_object('role',stolen_role,'apparentRole',stolen_role) when p->>'id'=target then p||jsonb_build_object('role','villager','decoy',true) else p end) from jsonb_array_elements(g->'players') p));
  end if;
  return app_private.game_enter(g,'firstNight',at_ms);
 elsif phase='firstNight' and done then return app_private.game_enter(g,'discussion',at_ms);
 elsif phase='execution' and done then return app_private.game_enter(g||'{"victimId":null}'::jsonb,'night',at_ms);
 elsif phase='morning' and done then return app_private.game_enter(g||'{"voteResult":null}'::jsonb,'discussion',at_ms);
 elsif phase='discussion' and at_ms >= (g->>'deadline')::bigint then return app_private.game_enter(g,'vote',at_ms);
 elsif phase in ('vote','runoff') and done then
  select jsonb_object_agg(id,n) into counts from (select candidate.id,(select count(*) from jsonb_each_text(g->'selections') c where c.value=candidate.id) n from (select p->>'id' id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and (phase='vote' or (g->'runoffIds') ? (p->>'id')) union all select '__no_execution__' where (g->>'day')::integer=1 and (phase='vote' or (g->'runoffIds') ? '__no_execution__')) candidate) votes;
  select jsonb_agg(key order by key) into leaders from jsonb_each_text(counts) c where c.value::integer=(select max(value::integer) from jsonb_each_text(counts));
  winning_choice:=case when jsonb_array_length(leaders)=1 then leaders->>0 else null end; target:=case when winning_choice='__no_execution__' then null else winning_choice end;
  g:=jsonb_set(g,'{voteResult}',jsonb_build_object('counts',counts,'executedId',target,'runoffIds',case when winning_choice is null and phase='vote' then leaders else '[]'::jsonb end));
  if winning_choice is null and phase='vote' then g:=app_private.game_enter(g,'runoff',at_ms);return jsonb_set(g,'{runoffIds}',leaders);end if;
  if target is not null then
   select p->>'role' into target_role from jsonb_array_elements(g->'players') p where p->>'id'=target;
   for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean loop if g->'selections'->>(actor->>'id')=target and ((actor->>'role' not in ('wolf','madman') and target_role='wolf') or (actor->>'role' in ('wolf','madman') and target_role not in ('wolf','madman'))) then g:=app_private.score_record(g,actor->>'id','contribution');end if;end loop;
   g:=app_private.game_kill(g,target,'execution');
   for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and coalesce(p->>'decoy','false')::boolean and p->>'apparentRole'='medium' loop g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',actor->>'id','targetId',target,'isWolf',false,'kind','medium','day',g->'day')));end loop;
  end if;
  winner:=app_private.game_winner(g);if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);end if;return app_private.game_enter(g,'execution',at_ms);
 elsif phase='night' and done then
  select max(weight) into max_weight from (select g->'selections'->>(p->>'id') id,sum(coalesce((g->'attackStrengths'->>(p->>'id'))::integer,2)) weight from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='wolf' group by 1) weighted;
  select id into target from (select g->'selections'->>(p->>'id') id,sum(coalesce((g->'attackStrengths'->>(p->>'id'))::integer,2)) weight from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='wolf' group by 1) weighted where weight=max_weight order by gen_random_uuid() limit 1;
  select g->'selections'->>(p->>'id') into guard_target from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='knight';
  select p->>'id' into seer_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='seer';
  if seer_id is not null then select p->>'role'='wolf' into is_wolf from jsonb_array_elements(g->'players') p where p->>'id'=g->'selections'->>seer_id;g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',seer_id,'targetId',g->'selections'->>seer_id,'isWolf',is_wolf,'kind','seer','day',g->'day')));end if;
  if is_wolf then g:=app_private.score_record(g,seer_id,'contribution',g->'selections'->>seer_id);end if;
  for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and coalesce(p->>'decoy','false')::boolean and p->>'apparentRole'='seer' loop g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',actor->>'id','targetId',g->'selections'->>(actor->>'id'),'isWolf',false,'kind','seer','day',g->'day')));end loop;
  if target is not null and target=guard_target then select p->>'id' into knight_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='knight';g:=app_private.score_record(g,knight_id,'contribution');target:=null;end if;
  if target is not null then g:=app_private.game_kill(g,target,'attack');end if;
  for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean loop g:=app_private.score_record(g,actor->>'id','survival');end loop;
  g:=g||jsonb_build_object('victimId',target,'day',(g->>'day')::integer+1);winner:=app_private.game_winner(g);if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);end if;return app_private.game_enter(g,'morning',at_ms);
 end if;return g;
end; $$;

create or replace function app_private.game_view(g jsonb,viewer text) returns jsonb
language plpgsql set search_path='' as $$
declare me jsonb; pub jsonb; priv jsonb; wolves jsonb; shown text;
begin
 select p into me from jsonb_array_elements(g->'players') p where p->>'id'=viewer;if me is null then raise exception '参加者ではありません。';end if;shown:=case when coalesce(me->>'decoy','false')::boolean then coalesce(me->>'apparentRole',me->>'initialRole') else me->>'role' end;
 pub:=jsonb_build_object('resultConfirmation',true,'id',g->'id','hostId',g->'hostId','phase',g->'phase','phaseId',g->'phaseId','day',g->'day','deadline',g->'deadline','winner',g->'winner','scores',case when g->>'phase'='finished' then g->'scores' else null end,'followedIds',case when (g->>'phase'='execution' and g->'voteResult'->>'executedId'=g->'lastElimination'->>'playerId' and g->'lastElimination'->>'cause'='execution') or (g->>'phase'='morning' and g->>'victimId' is not null and g->'lastElimination'->>'cause'='attack') then coalesce(g->'lastElimination'->'followedIds','[]'::jsonb) else '[]'::jsonb end,'ending',case when g->>'phase'='finished' then g->'lastElimination' else null end,'runoffIds',g->'runoffIds','voteResult',g->'voteResult','victimId',g->'victimId','removals',g->'removals','publicLog',coalesce(g->'publicLog','[]'::jsonb),'players',(select jsonb_agg(case when g->>'phase'='finished' then (p-'apparentRole'-'decoy') else p-'role'-'initialRole'-'apparentRole'-'decoy' end) from jsonb_array_elements(g->'players') p),'composition',(select jsonb_object_agg(role,n) from (select role,(select count(*) from jsonb_array_elements(g->'players') p where coalesce(p->>'initialRole',p->>'role')=role)n from unnest(array['villager','wolf','seer','medium','knight','madman','lover','baker','thief'])role)counts),'breadDelivered',g->>'phase'='morning' and exists(select 1 from jsonb_array_elements(g->'players')p where (p->>'alive')::boolean and p->>'role'='baker'),'requiredCount',(select count(*) from jsonb_array_elements(g->'players')p where (p->>'alive')::boolean),'completedCount',(select count(*) from jsonb_array_elements(g->'players')p where (p->>'alive')::boolean and (g->'confirmed')?(p->>'id')));
 if (me->>'alive')::boolean and g->>'phase'<>'finished' then
  priv:=jsonb_build_object('role',shown,'confirmed',(g->'confirmed')?viewer,'selection',g->'selections'->viewer,'attackStrength',g->'attackStrengths'->viewer,'results',(select coalesce(jsonb_agg(s),'[]'::jsonb)from jsonb_array_elements(g->'secrets')s where s->>'recipientId'=viewer),'loverId',case when shown='lover' then (select p->>'id' from jsonb_array_elements(g->'players')p where p->>'id'<>viewer and (case when me->>'initialRole'='lover' then p->>'initialRole'='lover' else p->>'role'='lover' end)limit 1)else null end);
  if shown='wolf' then wolves:=jsonb_build_object('memberIds',(select coalesce(jsonb_agg(p->'id'),'[]'::jsonb)from jsonb_array_elements(g->'players')p where case when me->>'initialRole'='wolf' then p->>'initialRole'='wolf' else p->>'role'='wolf' end),'selections','[]'::jsonb);end if;
 end if;return jsonb_build_object('public',pub,'private',priv,'wolves',wolves);
end; $$;

create or replace function public.game_command_thief(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r app_private.rooms%rowtype;me app_private.members%rowtype;g jsonb;p jsonb;target jsonb;shown text;receipt text;fingerprint jsonb;result jsonb;comp jsonb;role text;pool text[]:=array[]::text[];players jsonb:='[]'::jsonb;member record;n integer;total integer:=0;wolves integer;idx integer:=0;at_ms bigint;start_request text;
begin
 perform app_private.assert_site_access();
 if action not in ('start','get','select','confirm','next','startVote','extend','remove','rematch') then raise exception '操作が不正です。';end if;
 if action not in ('start','select','confirm') then return app_private.thief_response(public.game_command_public_log(action,payload),(payload->>'roomId')::uuid);end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;select * into me from app_private.members where room_id=r.id and user_id=auth.uid();if not found then raise exception 'この部屋に参加していません。';end if;at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if action='start' then
  if r.host_id<>me.id then raise exception '主催者のみ開始できます。';end if;start_request:=(payload->>'requestId')::uuid::text;select state into g from app_private.games where room_id=r.id;
  if r.status<>'waiting' then if g->>'startRequest'=start_request then return app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);end if;raise exception 'すでにゲームが始まっています。';end if;
  if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が変わりました。';end if;select count(*) into n from app_private.members where room_id=r.id;if n not between 5 and 13 then raise exception '開始には5〜13人必要です。';end if;
  comp:='{"madman":0,"lover":0,"baker":0,"thief":0}'::jsonb||coalesce(r.composition,app_private.default_composition(n));
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief'] loop total:=total+(comp->>role)::integer;pool:=pool||array_fill(role,array[(comp->>role)::integer]);end loop;wolves:=(comp->>'wolf')::integer;if total<>n or wolves<1 or wolves>=n-wolves or (comp->>'lover')::integer not in(0,2) or (comp->>'thief')::integer>1 then raise exception '配役が不正です。';end if;
  select array_agg(value order by gen_random_uuid())into pool from unnest(pool)value;for member in select id from app_private.members where room_id=r.id order by seat loop idx:=idx+1;players:=players||jsonb_build_array(jsonb_build_object('id',member.id,'role',pool[idx],'initialRole',pool[idx],'apparentRole',pool[idx],'alive',true));end loop;
  g:=jsonb_build_object('id',gen_random_uuid(),'startRequest',start_request,'hostId',r.host_id,'players',players,'phase','roles','phaseId',1,'day',1,'discussionMs',r.discussion_minutes*60000,'deadline',null,'selections','{}'::jsonb,'attackStrengths','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,'voteResult',null,'victimId',null,'winner',null,'secrets','[]'::jsonb,'removals','[]'::jsonb,'receipts','{}'::jsonb,'publicLog','[]'::jsonb,'scoring',jsonb_build_object('victoryPoints',r.victory_points,'stats','{}'::jsonb));insert into app_private.games values(r.id,g)on conflict(room_id)do update set state=excluded.state;update app_private.rooms set status='playing',revision=revision+1,updated_at=now()where id=r.id returning * into r;update public.room_updates set revision=r.revision where room_id=r.id;return app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);
 end if;
 select state into g from app_private.games where room_id=r.id;if g is null then raise exception '試合が見つかりません。';end if;select value into p from jsonb_array_elements(g->'players')where value->>'id'=me.id::text;shown:=case when coalesce(p->>'decoy','false')::boolean then p->>'apparentRole' else p->>'role'end;
 if action='confirm' then
  if (g->>'phase'='roles' and shown='thief' or g->>'phase'='night' and shown in('wolf','seer','knight')) and not(g->'selections')?me.id::text then raise exception '先に対象を選んでください。';end if;
  return app_private.thief_response(public.game_command_public_log(action,payload),r.id);
 end if;
 if payload->>'gameId'is distinct from g->>'id' or (payload->>'phaseId')::integer is distinct from(g->>'phaseId')::integer then raise exception '最新の画面で操作してください。';end if;if not(p->>'alive')::boolean or(g->'confirmed')?me.id::text then raise exception '操作できません。';end if;
 if not(g->>'phase'='roles' and shown='thief' or g->>'phase'='night' and shown in('wolf','seer','knight')) then return app_private.thief_response(public.game_command_public_log(action,payload),r.id);end if;
 select value into target from jsonb_array_elements(g->'players')where value->>'id'=payload->>'targetId' and(value->>'alive')::boolean;if target is null or target->>'id'=me.id::text then raise exception '対象が不正です。';end if;
 if shown='wolf' and g->>'phase'='night' and coalesce(payload->>'strength','')!~'^[123]$' then raise exception '襲撃の希望度を選んでください。';end if;
 receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId','targetId',payload->'targetId','strength',payload->'strength');if g->'receipts'?receipt then if g->'receipts'->receipt<>fingerprint then raise exception '同じ操作IDの内容が異なります。';end if;else g:=jsonb_set(g,array['selections',me.id::text],target->'id');if shown='wolf'and g->>'phase'='night'then g:=jsonb_set(g,array['attackStrengths',me.id::text],to_jsonb((payload->>'strength')::integer));end if;g:=jsonb_set(g,array['receipts',receipt],fingerprint);update app_private.games set state=g where room_id=r.id;update app_private.rooms set revision=revision+1,updated_at=now()where id=r.id returning * into r;update public.room_updates set revision=r.revision where room_id=r.id;end if;
 return app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);
end; $$;

revoke all on function app_private.thief_response(jsonb,uuid),app_private.game_settle(jsonb,bigint),app_private.game_view(jsonb,text),app_private.validate_victory_points(jsonb) from public,anon,authenticated;
revoke all on function public.lobby_command_thief(text,jsonb),public.game_command_thief(text,jsonb) from public,anon;
grant execute on function public.lobby_command_thief(text,jsonb),public.game_command_thief(text,jsonb) to authenticated;
commit;
