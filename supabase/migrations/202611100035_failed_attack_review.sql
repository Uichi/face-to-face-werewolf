-- Apply after 034. Attack reviews remain private until the match finishes.
begin;
do $$begin
 if position('fanaticWolfIds' in pg_get_functiondef('app_private.bodybuilder_view(jsonb,text)'::regprocedure))=0 then
  raise exception '先に034のSQLを適用してください。';
 end if;
end$$;

create or replace function app_private.bodybuilder_settle(g jsonb,at_ms bigint) returns jsonb
language plpgsql set search_path='' as $$
declare phase text:=g->>'phase'; done boolean; target text; leaders jsonb; counts jsonb; winner text; actor jsonb; target_role text; winning_choice text; thief_id text; stolen_role text; guard_target text; seer_id text; is_wolf boolean; knight_id text; max_weight integer;baker_id text; bread_choice text;last_targets jsonb; doses jsonb; history jsonb; injected text[]:=array[]::text[]; direct_ids text[]:=array[]::text[]; followed text[]:=array[]::text[]; deaths jsonb:='[]'; attacked text; hunter_id text; dose_target text; fatal boolean; attack_reasons jsonb; muscle_saved boolean:=false;
begin
 if phase in('finished','hunter','execution','morning') then return g; end if;
 select not exists(select 1 from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and not (g->'confirmed') ? (p->>'id')) into done;
 if phase in ('firstNight','night') and done then g:=app_private.shishimai_distribute(g); end if;
 if phase='roles' and done then
  select p->>'id' into thief_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='thief';
  if thief_id is not null then
   target:=g->'selections'->>thief_id;
   select p->>'role' into stolen_role from jsonb_array_elements(g->'players') p where p->>'id'=target and (p->>'alive')::boolean and p->>'id'<>thief_id;
   if stolen_role is null then raise exception '怪盗の対象が不正です。'; end if;
   g:=jsonb_set(g,'{players}',(select jsonb_agg(case when p->>'id'=thief_id then p||jsonb_build_object('role',stolen_role,'apparentRole',stolen_role,'wolfbound',coalesce((select (q->>'wolfbound')::boolean from jsonb_array_elements(g->'players')q where q->>'id'=target),false)) when p->>'id'=target then p||jsonb_build_object('role','villager','decoy',true,'wolfbound',false) else p end) from jsonb_array_elements(g->'players') p));
  end if;
  return app_private.game_enter(g,'firstNight',at_ms);
 elsif phase='firstNight' and done then
  select p->>'id' into baker_id from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and p->>'role'='baker';
  g:=app_private.hunter_bread(g,baker_id,g->'selections'->>baker_id,0);return app_private.game_enter(g,'discussion',at_ms);
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
   for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'<>'shishimai' loop if g->'selections'->>(actor->>'id')=target and ((actor->>'role' not in ('wolf','madman','fanatic') and target_role='wolf') or (actor->>'role' in ('wolf','madman','fanatic') and target_role not in ('wolf','madman','fanatic'))) then g:=app_private.score_record(g,actor->>'id','contribution');end if;end loop;
   g:=app_private.game_kill(g,target,'execution');g:=app_private.hunter_log(g,'execution',target);
   for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and coalesce(p->>'decoy','false')::boolean and p->>'apparentRole'='medium' loop g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',actor->>'id','targetId',target,'isWolf',false,'kind','medium','day',g->'day')));end loop;
  end if;
  if target is null then g:=app_private.hunter_log(g,'noExecution');end if;
  g:=app_private.hunter_wait(g,target,'execution',at_ms);if g->>'phase'='hunter'then return g;end if;
  winner:=app_private.game_winner(g);if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);end if;return app_private.game_enter(g,'execution',at_ms);
 elsif phase='night' and done then
  select p->>'id' into baker_id from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and p->>'role'='baker';
  g:=g||jsonb_build_object('nightPending',jsonb_build_object('bakerId',baker_id,'breadChoice',g->'selections'->>baker_id));
  last_targets:=coalesce(g->'lastGuardTargets','{}'::jsonb);
  for actor in select p from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and(case when coalesce((p->>'decoy')::boolean,false)then p->>'apparentRole'else p->>'role'end)='knight'loop last_targets:=jsonb_set(last_targets,array[actor->>'id'],g->'selections'->(actor->>'id'),true);end loop;
  g:=jsonb_set(g,'{lastGuardTargets}',last_targets,true);
  select max(weight) into max_weight from (select g->'selections'->>(p->>'id') id,sum(coalesce((g->'attackStrengths'->>(p->>'id'))::integer,2)) weight from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='wolf' group by 1) weighted;
  select id into target from (select g->'selections'->>(p->>'id') id,sum(coalesce((g->'attackStrengths'->>(p->>'id'))::integer,2)) weight from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='wolf' group by 1) weighted where weight=max_weight order by gen_random_uuid() limit 1;
  select g->'selections'->>(p->>'id') into guard_target from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='knight';
  select p->>'id' into seer_id from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and p->>'role'='seer';
  if seer_id is not null then select p->>'role'='wolf' into is_wolf from jsonb_array_elements(g->'players') p where p->>'id'=g->'selections'->>seer_id;g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',seer_id,'targetId',g->'selections'->>seer_id,'isWolf',is_wolf or coalesce((select(q->>'wolfbound')::boolean from jsonb_array_elements(g->'players')q where q->>'id'=g->'selections'->>seer_id),false),'kind','seer','day',g->'day')));end if;
  if is_wolf then g:=app_private.score_record(g,seer_id,'contribution',g->'selections'->>seer_id);end if;
  for actor in select p from jsonb_array_elements(g->'players') p where (p->>'alive')::boolean and coalesce(p->>'decoy','false')::boolean and p->>'apparentRole'='seer' loop g:=jsonb_set(g,'{secrets}',coalesce(g->'secrets','[]'::jsonb)||jsonb_build_array(jsonb_build_object('recipientId',actor->>'id','targetId',g->'selections'->>(actor->>'id'),'isWolf',false,'kind','seer','day',g->'day')));end loop;
  attacked:=target;doses:=coalesce(g->'injectionCounts','{}');history:=coalesce(g->'injectionHistory','[]');
  for actor in select p from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and(case when coalesce((p->>'decoy')::boolean,false)then p->>'apparentRole'else p->>'role'end)='doctor'loop
   dose_target:=g->'selections'->>(actor->>'id');history:=history||jsonb_build_array(jsonb_build_object('actorId',actor->>'id','targetId',dose_target,'day',g->'day'));
   if actor->>'role'='doctor'and dose_target<>'__no_injection__'then doses:=jsonb_set(doses,array[dose_target],to_jsonb(coalesce((doses->>dose_target)::integer,0)+1));injected:=array_append(injected,dose_target);end if;
  end loop;
  g:=g||jsonb_build_object('injectionCounts',doses,'injectionHistory',history);
  if attacked is not null and attacked is distinct from guard_target and not attacked=any(injected)
   and not coalesce(g->'enduranceUsed','{}'::jsonb)?attacked
   and exists(select 1 from jsonb_array_elements(g->'players')p where p->>'id'=attacked and(p->>'alive')::boolean and p->>'role'='bodybuilder')then
   muscle_saved:=true;g:=g||jsonb_build_object('enduranceUsed',coalesce(g->'enduranceUsed','{}'::jsonb)||jsonb_build_object(attacked,(g->>'day')::integer));
  end if;
  for actor in select p from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean loop
   dose_target:=actor->>'id';fatal:=dose_target=any(injected)and(doses->>dose_target)::integer>=2;
   if fatal or dose_target=attacked and not muscle_saved and dose_target is distinct from guard_target and not dose_target=any(injected)then direct_ids:=array_append(direct_ids,dose_target);end if;
  end loop;
  if attacked is not null then
   attack_reasons:='[]';
   if attacked=any(direct_ids) and attacked=any(injected) then
    attack_reasons:='["injection"]';
   else
    if attacked=guard_target then attack_reasons:=attack_reasons||'["guard"]'::jsonb;end if;
    if attacked=any(injected) then attack_reasons:=attack_reasons||'["doctor"]'::jsonb;end if;
    if muscle_saved then attack_reasons:=attack_reasons||'["endurance"]'::jsonb;end if;
   end if;
   if jsonb_array_length(attack_reasons)>0 then
    g:=g||jsonb_build_object('failedAttacks',coalesce(g->'failedAttacks','[]')||
     jsonb_build_array(jsonb_build_object('day',g->'day','targetId',attacked,'reasons',attack_reasons)));
   end if;
  end if;
  target:=case when attacked=any(direct_ids)and not attacked=any(injected)then attacked else null end;
  if exists(select 1 from jsonb_array_elements(g->'players')p where p->>'id'=any(direct_ids)and p->>'role'='lover')then select coalesce(array_agg(p->>'id'),array[]::text[])into followed from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and p->>'role'='lover'and not p->>'id'=any(direct_ids);end if;
  if attacked is not null and not attacked=any(direct_ids||followed)then
   if attacked=guard_target then select p->>'id'into knight_id from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and p->>'role'='knight';g:=app_private.score_record(g,knight_id,'contribution');end if;
   for actor in select p from jsonb_array_elements(g->'players')p where(p->>'alive')::boolean and p->>'role'='doctor'and g->'selections'->>(p->>'id')=attacked loop g:=app_private.score_record(g,actor->>'id','contribution');end loop;
  end if;
  for actor in select p from jsonb_array_elements(g->'players')p where p->>'id'=any(direct_ids)loop
   dose_target:=actor->>'id';fatal:=dose_target=any(injected);
   g:=g||jsonb_build_object('lastElimination',jsonb_build_object('playerId',dose_target,'cause',case when fatal then 'injection'else 'attack'end,'day',g->'day','followedIds',case when actor->>'role'='lover'then to_jsonb(followed)else '[]'::jsonb end));
   deaths:=deaths||jsonb_build_array(g->'lastElimination');g:=app_private.hunter_log(g,case when fatal then 'injection'else 'attack'end,dose_target);
   if actor->>'role'='hunter'then hunter_id:=dose_target;end if;
  end loop;
  g:=jsonb_set(g,'{players}',(select jsonb_agg(case when p->>'id'=any(direct_ids||followed)then p||'{"alive":false}'::jsonb else p end)from jsonb_array_elements(g->'players')p));
  if target is null then g:=app_private.hunter_log(g,'noVictim');end if;
  g:=g||jsonb_build_object('victimId',target,'nightDeaths',deaths);g:=app_private.hunter_wait(g,hunter_id,'morning',at_ms);if g->>'phase'='hunter'then return g;end if;
  g:=app_private.hunter_finish_night(g);winner:=app_private.game_winner(g);if winner is not null then return app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);end if;return app_private.game_enter(g,'morning',at_ms);
 end if;return g;
end; $$;

create or replace function app_private.bodybuilder_view(g jsonb, viewer text)
returns jsonb language plpgsql set search_path='' as $$
declare
 result jsonb;
 remaining integer;
 decoy boolean;
begin
 result := app_private.bodybuilder_view_before_shishimai_result(g,viewer);
 if g->>'phase'='finished' then
  result:=jsonb_set(result,'{public,failedAttacks}',coalesce(g->'failedAttacks','[]'),true);
 end if;
 if result#>>'{private,role}'='fanatic' and g->>'phase'<>'roles' then
  select coalesce((p->>'decoy')::boolean,false) into decoy
  from jsonb_array_elements(g->'players') p where p->>'id'=viewer;
  result:=jsonb_set(result,'{private,fanaticWolfIds}',(
   select coalesce(jsonb_agg(p->>'id'),'[]') from jsonb_array_elements(g->'players') p
   where (case when decoy then p->>'initialRole' else p->>'role' end)='wolf'
  ),true);
 end if;
 if jsonb_typeof(result#>'{public,composition}')='object' and exists (
  select 1 from jsonb_array_elements(g->'players') p where coalesce(p->>'initialRole',p->>'role')='fanatic'
 ) then
  result:=jsonb_set(result,'{public,composition,fanatic}','1',true);
 end if;
 if g->>'phase'='finished' and exists (
  select 1 from jsonb_array_elements(g->'players') p
  where p->>'id'=viewer and p->>'role'='shishimai' and (p->>'alive')::boolean
 ) then
  select count(*) into remaining from jsonb_array_elements(g->'players') p
  where (p->>'alive')::boolean and p->>'id'<>viewer and not coalesce(g->'blessings','[]')?(p->>'id');
  if remaining>0 then
   result := jsonb_set(result,'{personalNotice}',jsonb_build_object('kind','shishimaiShortfall','remaining',remaining),true);
  end if;
 end if;
 return result;
end $$;

commit;
