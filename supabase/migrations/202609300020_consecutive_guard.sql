-- Make consecutive guarding configurable per room. Apply after 202609300019_bread_choices.sql. Rerunnable.
begin;

alter table app_private.rooms add column if not exists consecutive_guard boolean not null default true;

-- Also qualify the room column in the preceding bread helper. This replaces the
-- same function safely for projects that already applied migration 019.
create or replace function app_private.bread_choice_response(result jsonb,room_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare g jsonb;delivery jsonb;delivered boolean:=false;
begin
 select games.state into g from app_private.games games where games.room_id=bread_choice_response.room_id;
 result:=jsonb_set(result,'{room,breadChoices}','true'::jsonb,true);
 if result->'game'is null or g is null then return result;end if;
 delivery:=g->'breadDelivery';
 delivered:=(g->>'phase'='morning'and delivery is not null)or(g->>'phase'='discussion'and(g->>'day')::integer=1 and delivery->>'day'='0');
 result:=jsonb_set(result,'{game,public,breadDelivery}',coalesce(delivery,'null'::jsonb),true);
 result:=jsonb_set(result,'{game,public,breadDelivered}',to_jsonb(delivered),true);
 result:=jsonb_set(result,'{game,public,publicLog}',coalesce(g->'publicLog','[]'::jsonb),true);
 return result;
end;$$;

create or replace function app_private.guard_setting_response(result jsonb,room_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare r app_private.rooms%rowtype;g jsonb;me app_private.members%rowtype;last_target text;
begin
 select * into r from app_private.rooms where id=guard_setting_response.room_id;
 if not found then return result;end if;
 result:=jsonb_set(result,'{room,consecutiveGuard}',to_jsonb(r.consecutive_guard),true);
 select games.state into g from app_private.games games where games.room_id=r.id;
 if result->'game'is not null and g is not null then
  result:=jsonb_set(result,'{game,public,consecutiveGuard}',to_jsonb(coalesce((g->>'consecutiveGuard')::boolean,true)),true);
  select * into me from app_private.members members where members.room_id=r.id and members.user_id=auth.uid();
  if result#>'{game,private}'is not null then
   last_target:=g->'lastGuardTargets'->>me.id::text;
   result:=jsonb_set(result,'{game,private,lastGuardTargetId}',coalesce(to_jsonb(last_target),'null'::jsonb),true);
  end if;
 end if;
 return result;
end;$$;

create or replace function public.lobby_command_guard(action text,payload jsonb default'{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=''as $$
declare result jsonb;room_id uuid;enabled boolean;
begin
 if action='settings'and payload?'consecutiveGuard'then
  if jsonb_typeof(payload->'consecutiveGuard')<>'boolean'then raise exception'連続護衛の設定が不正です。';end if;
  enabled:=(payload->>'consecutiveGuard')::boolean;
 end if;
 result:=public.lobby_command_thief(action,payload);room_id:=(result#>>'{room,id}')::uuid;
 if action='settings'and payload?'consecutiveGuard'and room_id is not null then
  update app_private.rooms set consecutive_guard=enabled where id=room_id;
 end if;
 return app_private.guard_setting_response(result,room_id);
end;$$;

create or replace function public.game_command_guard(action text,payload jsonb default'{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=''as $$
declare target_room uuid:=(payload->>'roomId')::uuid;r app_private.rooms%rowtype;me app_private.members%rowtype;
 before_g jsonb;after_g jsonb;result jsonb;p jsonb;shown text;last_targets jsonb;choice text;at_ms bigint;
begin
 select * into r from app_private.rooms where id=target_room;
 select state into before_g from app_private.games where room_id=target_room;
 if action='select'and before_g->>'phase'='night'and not coalesce((before_g->>'consecutiveGuard')::boolean,true)then
  select * into me from app_private.members where room_id=target_room and user_id=auth.uid();
  select value into p from jsonb_array_elements(before_g->'players')where value->>'id'=me.id::text;
  shown:=case when coalesce(p->>'decoy','false')::boolean then p->>'apparentRole'else p->>'role'end;
  if shown='knight'and before_g->'lastGuardTargets'->>me.id::text=payload->>'targetId'then
   raise exception'前の夜と同じ人は続けて護衛できません。';
  end if;
 end if;
 result:=public.game_command_bread(action,payload);
 select state into after_g from app_private.games where room_id=target_room;
 if action='start'and after_g is not null then
  after_g:=jsonb_set(after_g,'{consecutiveGuard}',to_jsonb(r.consecutive_guard),true);
  after_g:=jsonb_set(after_g,'{lastGuardTargets}','{}'::jsonb,true);
 elsif before_g->>'phase'='night'and after_g->>'phase'is distinct from before_g->>'phase'then
  last_targets:=coalesce(after_g->'lastGuardTargets','{}'::jsonb);
  for p in select value from jsonb_array_elements(before_g->'players')loop
   shown:=case when coalesce(p->>'decoy','false')::boolean then p->>'apparentRole'else p->>'role'end;
   choice:=before_g->'selections'->>(p->>'id');
   if (p->>'alive')::boolean and shown='knight'and choice is not null then last_targets:=jsonb_set(last_targets,array[p->>'id'],to_jsonb(choice),true);end if;
  end loop;
  after_g:=jsonb_set(after_g,'{lastGuardTargets}',last_targets,true);
 end if;
 if after_g is distinct from before_g then
  update app_private.games set state=after_g where room_id=target_room;
  if action='start'or(before_g->>'phase'='night'and after_g->>'phase'is distinct from before_g->>'phase')then
   update app_private.rooms set revision=revision+1,updated_at=now()where id=target_room returning*into r;
   update public.room_updates set revision=r.revision where room_id=target_room;
   select * into me from app_private.members where room_id=target_room and user_id=auth.uid();at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
   result:=app_private.thief_response(app_private.snapshot(target_room)||jsonb_build_object('game',app_private.game_view(after_g,me.id::text),'serverNow',at_ms),target_room);
  end if;
 end if;
 return app_private.guard_setting_response(result,target_room);
end;$$;

revoke all on function app_private.guard_setting_response(jsonb,uuid)from public,anon,authenticated;
revoke all on function public.lobby_command_guard(text,jsonb),public.game_command_guard(text,jsonb)from public,anon;
grant execute on function public.lobby_command_guard(text,jsonb),public.game_command_guard(text,jsonb)to authenticated;
revoke execute on function public.lobby_command_thief(text,jsonb),public.game_command_bread(text,jsonb)from authenticated;
commit;
