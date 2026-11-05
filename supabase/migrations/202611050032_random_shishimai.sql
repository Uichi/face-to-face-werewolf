-- Apply after 031. Existing rooms retain the host's saved candidates.
begin;
do $$begin
 if to_regprocedure('app_private.bodybuilder_view_before_shishimai_result(jsonb,text)') is null then
  raise exception '先に031のSQLを適用してください。';
 end if;
end$$;

alter table app_private.rooms alter column random_candidates set default
 '["seer","medium","knight","madman","lover","baker","thief","hunter","doctor","bodybuilder","shishimai"]'::jsonb;

create or replace function app_private.random_composition(n integer,candidates jsonb) returns jsonb
language plpgsql volatile set search_path='' as $$
declare comp jsonb; options jsonb:='[]'; mask integer; i integer; role text; amount integer; villagers integer; wolves integer; bytes bytea; draw bigint; bound bigint; size integer; mixed integer; digit integer; radix integer; possibilities integer:=1;
begin
 if n not between 5 and 13 or jsonb_typeof(candidates) is distinct from 'array' then raise exception '人数または抽選候補が不正です。';end if;
 if exists(select 1 from jsonb_array_elements(candidates)v where jsonb_typeof(v)<>'string' or v#>>'{}' not in('seer','medium','knight','madman','lover','baker','thief','hunter','doctor','bodybuilder','shishimai')) or (select count(distinct v)from jsonb_array_elements(candidates)v)<>jsonb_array_length(candidates) then raise exception '抽選候補が不正です。';end if;
 wolves:=(app_private.default_composition(n)->>'wolf')::integer;
 for i in 0..jsonb_array_length(candidates)-1 loop possibilities:=possibilities*case when candidates->>i='doctor'then 3 else 2 end;end loop;
 for mask in 0..possibilities-1 loop
 mixed:=mask;
 comp:=jsonb_build_object('villager',0,'wolf',wolves,'seer',0,'medium',0,'knight',0,'madman',0,'lover',0,'baker',0,'thief',0,'hunter',0,'doctor',0,'bodybuilder',0);villagers:=n-wolves;
 for i in 0..jsonb_array_length(candidates)-1 loop
 role:=candidates->>i;radix:=case when role='doctor'then 3 else 2 end;digit:=mixed % radix;mixed:=mixed/radix;amount:=case when role='lover'then digit*2 else digit end;villagers:=villagers-amount;comp:=jsonb_set(comp,array[role],to_jsonb(amount));
 end loop;
 if villagers>=1 then options:=options||jsonb_build_array(jsonb_set(comp,'{villager}',to_jsonb(villagers)));end if;
 end loop;
 size:=jsonb_array_length(options);bound:=4294967296-(4294967296 % size);
 loop bytes:=extensions.gen_random_bytes(4);draw:=get_byte(bytes,0)::bigint*16777216+get_byte(bytes,1)::bigint*65536+get_byte(bytes,2)::bigint*256+get_byte(bytes,3);exit when draw<bound;end loop;
 return options->(draw % size)::integer;
end;$$;
create or replace function app_private.bodybuilder_response(result jsonb,target_room uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
begin
 target_room:=coalesce(target_room,(result#>>'{room,id}')::uuid);result:=app_private.random_response(result,target_room);
 result:=jsonb_set(result,'{room,doctorRole}','true'::jsonb,true);
 result:=jsonb_set(result,'{room,randomShishimai}','true'::jsonb,true);
 result:=jsonb_set(result,'{room,shishimaiRole}','true'::jsonb,true);
 result:=jsonb_set(result,'{room,bodybuilderRole}','true'::jsonb,true);
 if result#>'{room,composition}' is not null and result#>'{room,composition}'<>'null'::jsonb then result:=jsonb_set(result,'{room,composition}','{"doctor":0,"bodybuilder":0}'::jsonb||(result#>'{room,composition}'));end if;
 return result;
end;$$;


commit;
