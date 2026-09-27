-- Complete the night immediately once every living player has confirmed.
-- Existing games and permissions are preserved. Safe to run again.
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

revoke all on function app_private.game_settle(jsonb,bigint) from public,anon,authenticated;
commit;
