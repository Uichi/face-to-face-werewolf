-- Apply after 030. Include only the remaining count in the losing player's own view.
begin;
do $$
begin
 if to_regprocedure('app_private.shishimai_winner(jsonb)') is null then
  raise exception '先に030（獅子舞）のSQLを適用してください。';
 end if;
 if to_regprocedure('app_private.bodybuilder_view_before_shishimai_result(jsonb,text)') is null then
  execute replace(
   pg_get_functiondef('app_private.bodybuilder_view(jsonb,text)'::regprocedure),
   'FUNCTION app_private.bodybuilder_view(',
   'FUNCTION app_private.bodybuilder_view_before_shishimai_result('
  );
 end if;
end $$;

create or replace function app_private.bodybuilder_view(g jsonb, viewer text)
returns jsonb language plpgsql set search_path='' as $$
declare
 result jsonb;
 remaining integer;
begin
 result := app_private.bodybuilder_view_before_shishimai_result(g,viewer);
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

revoke all on function app_private.bodybuilder_view(jsonb,text),
 app_private.bodybuilder_view_before_shishimai_result(jsonb,text) from public,anon,authenticated;
commit;
