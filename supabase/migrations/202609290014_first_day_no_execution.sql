-- Add “nobody is executed” as a ballot choice on day one.
-- Apply after 202609290013_baker.sql. Rerunnable.
begin;

create or replace function app_private.game_settle(g jsonb, at_ms bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare phase text:=g->>'phase'; done boolean; seer_id text; target text; guard_target text; leaders jsonb; counts jsonb; winner text; choices jsonb; is_wolf boolean; actor jsonb; target_role text; knight_id text; winning_choice text;
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
     select candidate.id, (select count(*) from jsonb_each_text(g->'selections') c where c.value=candidate.id) n
     from (
       select p->>'id' id from jsonb_array_elements(g->'players') p
       where (p->>'alive')::boolean and (phase='vote' or (g->'runoffIds') ? (p->>'id'))
       union all
       select '__no_execution__' where (g->>'day')::integer=1 and (phase='vote' or (g->'runoffIds') ? '__no_execution__')
     ) candidate
   ) votes;
   select jsonb_agg(key order by key) into leaders from jsonb_each_text(counts) c where c.value::integer=(select max(value::integer) from jsonb_each_text(counts));
   winning_choice:=case when jsonb_array_length(leaders)=1 then leaders->>0 else null end;
   target:=case when winning_choice='__no_execution__' then null else winning_choice end;
   g:=jsonb_set(g,'{voteResult}',jsonb_build_object('counts',counts,'executedId',target,'runoffIds',case when winning_choice is null and phase='vote' then leaders else '[]'::jsonb end));
   if winning_choice is null and phase='vote' then
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

create or replace function public.game_command_first_day(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r app_private.rooms%rowtype; me app_private.members%rowtype; g jsonb; at_ms bigint; receipt text; fingerprint jsonb; result jsonb;
begin
 if action<>'select' or payload->>'targetId'<>'__no_execution__' then
   result:=public.game_command_baker(action,payload);
   if result ? 'room' and result->'room' is not null then result:=jsonb_set(result,'{room,firstDayNoExecution}','true'::jsonb,true); end if;
   return result;
 end if;
 perform app_private.assert_site_access();
 if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then raise exception 'この部屋に参加していません。'; end if;
 select state into g from app_private.games where room_id=r.id;
 if g is null or r.status<>'playing' then raise exception '試合が見つかりません。'; end if;
 if payload->>'gameId' is distinct from g->>'id' or (payload->>'phaseId')::integer is distinct from (g->>'phaseId')::integer then raise exception '最新の画面で操作してください。'; end if;
 if (g->>'day')::integer<>1 or g->>'phase' not in ('vote','runoff') then raise exception '「誰も処刑しない」は初日の投票だけ選べます。'; end if;
 if g->>'phase'='runoff' and not (g->'runoffIds') ? '__no_execution__' then raise exception '決選候補ではありません。'; end if;
 if not exists(select 1 from jsonb_array_elements(g->'players') p where p->>'id'=me.id::text and (p->>'alive')::boolean) then raise exception '脱落者は操作できません。'; end if;
 if (g->'confirmed') ? me.id::text then raise exception '確定済みです。'; end if;
 receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;
 fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId','targetId',payload->'targetId');
 if g->'receipts' ? receipt then
   if g->'receipts'->receipt<>fingerprint then raise exception '同じ操作IDの内容が異なります。'; end if;
 else
   g:=jsonb_set(g,array['selections',me.id::text],to_jsonb('__no_execution__'::text));
   g:=jsonb_set(g,array['receipts',receipt],fingerprint);
   update app_private.games set state=g where room_id=r.id;
   update app_private.rooms set revision=revision+1,updated_at=now() where id=r.id returning * into r;
   update public.room_updates set revision=r.revision where room_id=r.id;
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 result:=app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms);
 result:=app_private.baker_response(result,r.id);
 return jsonb_set(result,'{room,firstDayNoExecution}','true'::jsonb,true);
end;
$$;

revoke all on function app_private.game_settle(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.game_command_first_day(text,jsonb) from public,anon;
grant execute on function public.game_command_first_day(text,jsonb) to authenticated;
commit;
