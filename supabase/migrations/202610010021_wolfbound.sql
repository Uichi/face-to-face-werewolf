-- Add the secret wolfbound villager modifier. Apply after 202609300020_consecutive_guard.sql. Rerunnable.
begin;

alter table app_private.rooms add column if not exists wolfbound_enabled boolean not null default false;

create or replace function app_private.wolfbound_response(result jsonb,room_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare enabled boolean;g jsonb;
begin
 select rooms.wolfbound_enabled into enabled from app_private.rooms rooms where rooms.id=wolfbound_response.room_id;
 if found then result:=jsonb_set(result,'{room,wolfboundEnabled}',to_jsonb(enabled),true);end if;
 select games.state into g from app_private.games games where games.room_id=wolfbound_response.room_id;
 -- The modifier is secret from everyone, including its owner, until the result screen.
 if result#>'{game,public,players}'is not null and coalesce(g->>'phase','')<>'finished'then
  result:=jsonb_set(result,'{game,public,players}',(select coalesce(jsonb_agg(p-'wolfbound'-'initialWolfbound'),'[]'::jsonb)from jsonb_array_elements(result#>'{game,public,players}')p),true);
 end if;
 return result;
end;$$;

create or replace function public.lobby_command_wolfbound(action text,payload jsonb default'{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=''as $$
declare result jsonb;target_room uuid;enabled boolean;villagers integer;
begin
 if action='settings'and payload?'wolfboundEnabled'then
  if jsonb_typeof(payload->'wolfboundEnabled')<>'boolean'then raise exception'狼憑きの設定が不正です。';end if;
  enabled:=(payload->>'wolfboundEnabled')::boolean;
 end if;
 result:=public.lobby_command_guard(action,payload);target_room:=(result#>>'{room,id}')::uuid;
 if action='settings'and payload?'wolfboundEnabled'and target_room is not null then
  villagers:=coalesce((result#>>'{room,composition,villager}')::integer,0);
  if enabled and villagers<1 then raise exception'狼憑きを使用するには村人が1人以上必要です。';end if;
  update app_private.rooms set wolfbound_enabled=enabled where id=target_room;
 end if;
 return app_private.wolfbound_response(result,target_room);
end;$$;

create or replace function public.game_command_wolfbound(action text,payload jsonb default'{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=''as $$
declare target_room uuid:=(payload->>'roomId')::uuid;r app_private.rooms%rowtype;me app_private.members%rowtype;
 before_g jsonb;after_g jsonb;result jsonb;thief_id text;target_id text;seer_id text;at_ms bigint;
begin
 select * into r from app_private.rooms where id=target_room;
 select games.state into before_g from app_private.games games where games.room_id=target_room;
 result:=public.game_command_guard(action,payload);
 select games.state into after_g from app_private.games games where games.room_id=target_room;

 -- A new game id means a real start or rematch, never a retry of the same start request.
 if action='start'and after_g is not null and after_g->>'id'is distinct from before_g->>'id'then
  if r.wolfbound_enabled then
   if not exists(select 1 from jsonb_array_elements(after_g->'players')p where p->>'role'='villager')then raise exception'狼憑きを使用するには村人が1人以上必要です。';end if;
   if (get_byte(extensions.gen_random_bytes(1),0) & 1)=1 then
    select p->>'id' into target_id from jsonb_array_elements(after_g->'players')p where p->>'role'='villager'order by extensions.gen_random_uuid()limit 1;
    after_g:=jsonb_set(after_g,'{players}',(select jsonb_agg(case when p->>'id'=target_id then p||jsonb_build_object('wolfbound',true,'initialWolfbound',true)else p end)from jsonb_array_elements(after_g->'players')p),true);
   end if;
  end if;
 end if;

 -- The thief takes the hidden modifier together with the target's villager role.
 if before_g->>'phase'='roles'and after_g->>'phase'='firstNight'then
  select p->>'id' into thief_id from jsonb_array_elements(before_g->'players')p where p->>'role'='thief'and(p->>'alive')::boolean limit 1;
  target_id:=before_g->'selections'->>thief_id;
  if thief_id is not null and exists(select 1 from jsonb_array_elements(before_g->'players')p where p->>'id'=target_id and coalesce((p->>'wolfbound')::boolean,false))then
   after_g:=jsonb_set(after_g,'{players}',(select jsonb_agg(case when p->>'id'=thief_id then p||jsonb_build_object('wolfbound',true)when p->>'id'=target_id then p||jsonb_build_object('wolfbound',false)else p end)from jsonb_array_elements(after_g->'players')p),true);
  end if;
 end if;

 -- Only the seer's private result changes. Scoring remains tied to an actual wolf.
 if before_g->>'phase'='night'and after_g->>'phase'is distinct from before_g->>'phase'then
  select p->>'id' into seer_id from jsonb_array_elements(before_g->'players')p where p->>'role'='seer'and(p->>'alive')::boolean limit 1;
  target_id:=before_g->'selections'->>seer_id;
  if seer_id is not null and exists(select 1 from jsonb_array_elements(before_g->'players')p where p->>'id'=target_id and coalesce((p->>'wolfbound')::boolean,false))then
   after_g:=jsonb_set(after_g,'{secrets}',(select coalesce(jsonb_agg(case when s->>'recipientId'=seer_id and s->>'targetId'=target_id and s->>'kind'='seer'and s->>'day'=(before_g->>'day')then jsonb_set(s,'{isWolf}','true'::jsonb,true)else s end),'[]'::jsonb)from jsonb_array_elements(after_g->'secrets')s),true);
  end if;
 end if;

 if after_g is distinct from (select games.state from app_private.games games where games.room_id=target_room)then
  update app_private.games set state=after_g where room_id=target_room;
  update app_private.rooms set revision=revision+1,updated_at=now()where id=target_room returning*into r;
  update public.room_updates set revision=r.revision where room_id=target_room;
  select * into me from app_private.members where room_id=target_room and user_id=auth.uid();at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  result:=app_private.thief_response(app_private.snapshot(target_room)||jsonb_build_object('game',app_private.game_view(after_g,me.id::text),'serverNow',at_ms),target_room);
  result:=app_private.bread_choice_response(result,target_room);
  result:=app_private.guard_setting_response(result,target_room);
 end if;
 return app_private.wolfbound_response(result,target_room);
end;$$;

revoke all on function app_private.wolfbound_response(jsonb,uuid)from public,anon,authenticated;
revoke all on function public.lobby_command_wolfbound(text,jsonb),public.game_command_wolfbound(text,jsonb)from public,anon;
grant execute on function public.lobby_command_wolfbound(text,jsonb),public.game_command_wolfbound(text,jsonb)to authenticated;
revoke execute on function public.lobby_command_guard(text,jsonb),public.game_command_guard(text,jsonb)from authenticated;
commit;
