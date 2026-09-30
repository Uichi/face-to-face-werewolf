-- Let the baker choose a bread on the first night and every regular night.
-- Apply after 202609300018_host_result_progress.sql. Rerunnable.
begin;

create or replace function app_private.bread_choice_response(result jsonb,room_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare g jsonb;delivery jsonb;delivered boolean:=false;
begin
 select state into g from app_private.games where room_id=bread_choice_response.room_id;
 result:=jsonb_set(result,'{room,breadChoices}','true'::jsonb,true);
 if result->'game'is null or g is null then return result;end if;
 delivery:=g->'breadDelivery';
 delivered:=(g->>'phase'='morning'and delivery is not null)or(g->>'phase'='discussion'and(g->>'day')::integer=1 and delivery->>'day'='0');
 result:=jsonb_set(result,'{game,public,breadDelivery}',coalesce(delivery,'null'::jsonb),true);
 result:=jsonb_set(result,'{game,public,breadDelivered}',to_jsonb(delivered),true);
 result:=jsonb_set(result,'{game,public,publicLog}',coalesce(g->'publicLog','[]'::jsonb),true);
 return result;
end;$$;

create or replace function public.game_command_bread(action text,payload jsonb default'{}'::jsonb)returns jsonb
language plpgsql security definer set search_path=''as $$
declare r app_private.rooms%rowtype;me app_private.members%rowtype;g jsonb;before_g jsonb;after_g jsonb;p jsonb;baker jsonb;
 phase text;shown text;choice text;receipt text;fingerprint jsonb;result jsonb;delivery jsonb;event jsonb;event_id text;delivery_day integer;at_ms bigint;
begin
 if action='select'and payload->>'targetId'in('shokupan','croissant','melonpan','currypan','anpan','surprise')then
  perform app_private.assert_site_access();
  if auth.uid()is null then raise exception'ログインが必要です。';end if;
  select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval'24 hours'for update;
  if not found then raise exception'部屋が見つからないか、有効期限が切れています。';end if;
  select * into me from app_private.members where room_id=r.id and user_id=auth.uid();if not found then raise exception'この部屋に参加していません。';end if;
  select state into g from app_private.games where room_id=r.id;phase:=g->>'phase';
  if payload->>'gameId'is distinct from g->>'id'or(payload->>'phaseId')::integer is distinct from(g->>'phaseId')::integer then raise exception'最新の画面で操作してください。';end if;
  select value into p from jsonb_array_elements(g->'players')where value->>'id'=me.id::text;
  shown:=case when coalesce(p->>'decoy','false')::boolean then p->>'apparentRole'else p->>'role'end;
  if not(p->>'alive')::boolean or(g->'confirmed')?me.id::text then raise exception'操作できません。';end if;
  if shown<>'baker'or phase not in('firstNight','night')then raise exception'パンを選べる段階ではありません。';end if;
  receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId','targetId',payload->'targetId');
  if g->'receipts'?receipt then if g->'receipts'->receipt<>fingerprint then raise exception'同じ操作IDの内容が異なります。';end if;
  else g:=jsonb_set(g,array['selections',me.id::text],to_jsonb(payload->>'targetId'));g:=jsonb_set(g,array['receipts',receipt],fingerprint);
   update app_private.games set state=g where room_id=r.id;update app_private.rooms set revision=revision+1,updated_at=now()where id=r.id returning*into r;update public.room_updates set revision=r.revision where room_id=r.id;
  end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  result:=app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);
  return app_private.bread_choice_response(result,r.id);
 end if;

 select state into before_g from app_private.games where room_id=(payload->>'roomId')::uuid;
 if action='confirm'and before_g->>'phase'in('firstNight','night')then
  select m.* into me from app_private.members m where m.room_id=(payload->>'roomId')::uuid and m.user_id=auth.uid();
  select value into p from jsonb_array_elements(before_g->'players')where value->>'id'=me.id::text;
  shown:=case when coalesce(p->>'decoy','false')::boolean then p->>'apparentRole'else p->>'role'end;
  if shown='baker'and not(before_g->'selections')?me.id::text then raise exception'先にパンを選んでください。';end if;
 end if;
 result:=public.game_command_host_results(action,payload);
 select state into after_g from app_private.games where room_id=(payload->>'roomId')::uuid;
 if before_g is not null and before_g->>'phase'in('firstNight','night')and after_g->>'phase'is distinct from before_g->>'phase'then
  select value into baker from jsonb_array_elements(before_g->'players')where(value->>'alive')::boolean and value->>'role'='baker'limit 1;
  delivery:=null;
  if baker is not null and exists(select 1 from jsonb_array_elements(after_g->'players')x where x->>'id'=baker->>'id'and(x->>'alive')::boolean)then
   choice:=before_g->'selections'->>(baker->>'id');
   if choice='surprise'then choice:=(array['shokupan','croissant','melonpan','currypan','anpan'])[floor(random()*5)::integer+1];end if;
   if choice in('shokupan','croissant','melonpan','currypan','anpan')then
    delivery_day:=case when before_g->>'phase'='firstNight'then 0 else(before_g->>'day')::integer end;
    delivery:=jsonb_build_object('day',delivery_day,'breadType',choice);event_id:='bread-'||delivery_day||'-'||(before_g->>'phaseId');
    event:=jsonb_build_object('id',event_id,'day',delivery_day,'kind','bread','breadType',choice);
    if not exists(select 1 from jsonb_array_elements(coalesce(after_g->'publicLog','[]'::jsonb))e where e->>'id'=event_id)then after_g:=jsonb_set(after_g,'{publicLog}',coalesce(after_g->'publicLog','[]'::jsonb)||jsonb_build_array(event),true);end if;
   end if;
  end if;
  after_g:=jsonb_set(after_g,'{breadDelivery}',coalesce(delivery,'null'::jsonb),true);
  update app_private.games set state=after_g where room_id=(payload->>'roomId')::uuid;
  update app_private.rooms set revision=revision+1,updated_at=now()where id=(payload->>'roomId')::uuid returning*into r;update public.room_updates set revision=r.revision where room_id=r.id;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  result:=app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(after_g,me.id::text),'serverNow',at_ms),r.id);
 end if;
 return app_private.bread_choice_response(result,(payload->>'roomId')::uuid);
end;$$;

revoke all on function app_private.bread_choice_response(jsonb,uuid)from public,anon,authenticated;
revoke all on function public.game_command_bread(text,jsonb)from public,anon;
grant execute on function public.game_command_bread(text,jsonb)to authenticated;
-- All game writes go through the newest wrapper once this migration is active,
-- so a client cannot skip the baker selection by calling an older endpoint.
revoke execute on function public.game_command_host_results(text,jsonb)from authenticated;
revoke execute on function public.game_command_thief(text,jsonb)from authenticated;
revoke execute on function public.game_command_public_log(text,jsonb)from authenticated;
revoke execute on function public.game_command_first_day(text,jsonb)from authenticated;
revoke execute on function public.game_command_baker(text,jsonb)from authenticated;
revoke execute on function public.game_command(text,jsonb)from authenticated;
commit;
