-- Apply after 027. Reveal the precise exchange pair only after the game ends.
begin;
do $$
begin
 if to_regprocedure('app_private.bodybuilder_view(jsonb,text)') is null then raise exception '先に025〜027のSQLを適用してください。';end if;
 if to_regprocedure('app_private.bodybuilder_view_before_thief_reveal(jsonb,text)') is null then
  execute replace(pg_get_functiondef('app_private.bodybuilder_view(jsonb,text)'::regprocedure),'FUNCTION app_private.bodybuilder_view(','FUNCTION app_private.bodybuilder_view_before_thief_reveal(');
 end if;
end $$;
create or replace function app_private.bodybuilder_view(g jsonb,viewer text) returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb; thief jsonb; target jsonb;
begin
 result:=app_private.bodybuilder_view_before_thief_reveal(g,viewer);
 if g->>'phase'='finished' then
  select p into thief from jsonb_array_elements(g->'players') p where p->>'initialRole'='thief' and p->>'role'<>'thief' limit 1;
  select p into target from jsonb_array_elements(g->'players') p where coalesce((p->>'decoy')::boolean,false) limit 1;
  if thief is not null and target is not null then
   result:=jsonb_set(result,'{public,thiefReveal}',jsonb_build_object('thiefId',thief->>'id','targetId',target->>'id','stolenRole',thief->>'role'),true);
  end if;
 end if;
 return result;
end; $$;
revoke all on function app_private.bodybuilder_view(jsonb,text),app_private.bodybuilder_view_before_thief_reveal(jsonb,text) from public,anon,authenticated;
commit;
