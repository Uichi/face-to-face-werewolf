-- Show the final elimination and winner together. Includes immediate-night completion.
-- Run the whole file. Existing rooms and game records are preserved; rerunnable.
begin;
create or replace function app_private.game_kill(g jsonb, target text, reason text) returns jsonb
language plpgsql set search_path = '' as $$
declare victim jsonb; medium_id text;
begin
 select p into victim from jsonb_array_elements(g->'players') p where p->>'id'=target and (p->>'alive')::boolean;
 if victim is null then raise exception '脱落対象が生存していません。'; end if;
 g:=jsonb_set(g,'{players}',(select jsonb_agg(case when p->>'id'=target then p||'{"alive":false}'::jsonb else p end) from jsonb_array_elements(g->'players') p));
 if reason='execution' then
   select p->>'id' into medium_id from jsonb_array_elements(g->'players') p where p->>'role'='medium' and (p->>'alive')::boolean;
   if medium_id is not null then
     g:=jsonb_set(g,'{secrets}',(g->'secrets')||jsonb_build_array(jsonb_build_object('recipientId',medium_id,'targetId',target,'isWolf',victim->>'role'='wolf','kind','medium','day',g->'day')));
   end if;
 end if;
 return g || jsonb_build_object('lastElimination',jsonb_build_object('playerId',target,'cause',reason,'day',g->'day'));
end;
$$;

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

create or replace function app_private.game_view(g jsonb, viewer text) returns jsonb
language plpgsql set search_path = '' as $$
declare me jsonb; pub jsonb; priv jsonb; wolves jsonb;
begin
 select p into me from jsonb_array_elements(g->'players') p where p->>'id'=viewer;
 if me is null then raise exception '参加者ではありません。'; end if;
 pub:=jsonb_build_object('id',g->'id','hostId',g->'hostId','phase',g->'phase','phaseId',g->'phaseId','day',g->'day','deadline',g->'deadline','winner',g->'winner',
  'ending',case when g->>'phase'='finished' then g->'lastElimination' else null end,
  'runoffIds',g->'runoffIds','voteResult',g->'voteResult','victimId',g->'victimId','removals',g->'removals',
  'players',(select jsonb_agg(case when g->>'phase'='finished' then p else p-'role' end) from jsonb_array_elements(g->'players') p),
  'composition',(select jsonb_object_agg(role,n) from (select role,(select count(*) from jsonb_array_elements(g->'players') p where p->>'role'=role) n from unnest(array['villager','wolf','seer','medium','knight']) role) counts),
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

revoke all on function app_private.game_kill(jsonb,text,text),app_private.game_settle(jsonb,bigint),app_private.game_view(jsonb,text) from public,anon,authenticated;
commit;
