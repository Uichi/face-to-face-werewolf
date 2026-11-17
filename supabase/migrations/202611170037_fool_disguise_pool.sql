-- Apply after 036. Only new matches use the final composition to draw disguises.
begin;

create or replace function app_private.fool_disguise(comp jsonb) returns text
language plpgsql volatile set search_path='' as $$
declare candidates text[]; candidate_count integer; draw integer;
begin
 select array_agg(candidate.role order by candidate.position) into candidates
 from unnest(array['seer','medium','knight','doctor','baker','bodybuilder'])
      with ordinality candidate(role,position)
 where coalesce((comp->>candidate.role)::integer,0)>0;
 candidate_count:=coalesce(cardinality(candidates),0);
 if candidate_count=0 then return 'villager'; end if;
 loop
  draw:=get_byte(extensions.gen_random_bytes(1),0);
  exit when draw<256-256%candidate_count;
 end loop;
 return candidates[1+draw%candidate_count];
end;
$$;
revoke all on function app_private.fool_disguise(jsonb) from public,anon,authenticated;

do $$
declare
 definition text;
 old_draw constant text := $old$
       -- Rejection sampling gives each of the six disguises the same probability.
       loop disguise_draw:=get_byte(extensions.gen_random_bytes(1),0); exit when disguise_draw<252; end loop;
       shown:=(array['seer','medium','knight','doctor','baker','bodybuilder'])[1+disguise_draw%6];
$old$;
 new_draw constant text := E'\n       shown:=app_private.fool_disguise(comp);\n';
begin
 definition:=pg_get_functiondef(to_regprocedure('public.game_command_bodybuilder(text,jsonb)'));
 if position(new_draw in definition)>0 then return; end if;
 if definition is null or position(old_draw in definition)=0 then
  raise exception '先に036のSQLを適用してください。';
 end if;
 definition:=replace(definition,old_draw,new_draw);
 execute replace(definition,E' disguise_draw integer;\n','');
end;
$$;

commit;
