-- Add a village-side baker. Requires migrations 011 and 012.
-- Rerunnable; the original protected commands remain available to older clients.
begin;

alter table app_private.rooms alter column victory_points set default '{"villager":5,"wolf":6,"seer":5,"medium":5,"knight":5,"madman":6,"lover":5,"baker":5}'::jsonb;
update app_private.rooms set victory_points='{"baker":5}'::jsonb||victory_points where not victory_points ? 'baker';

create or replace function app_private.validate_victory_points(points jsonb) returns void
language plpgsql set search_path='' as $$
declare role text;
begin
  if jsonb_typeof(points) is distinct from 'object' or (select count(*) from jsonb_object_keys(points)) not in (7,8) then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover'] loop
    if jsonb_typeof(points->role) is distinct from 'number' or coalesce(points->>role,'') !~ '^(10|[0-9])$' then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
  end loop;
  if points ? 'baker' and (jsonb_typeof(points->'baker') is distinct from 'number' or coalesce(points->>'baker','') !~ '^(10|[0-9])$') then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
end;
$$;

create or replace function app_private.baker_response(result jsonb, target_room uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g jsonb; baker_count integer:=0; bread boolean:=false;
begin
  if result ? 'room' and result->'room' is not null then
    result:=jsonb_set(result,'{room,bakerRole}','true'::jsonb,true);
    result:=jsonb_set(result,'{room,victoryPoints}',coalesce(result->'room'->'victoryPoints','{}'::jsonb)||jsonb_build_object('baker',coalesce(result->'room'->'victoryPoints'->'baker','5'::jsonb)),true);
    if result->'room'->'composition' is not null then
      result:=jsonb_set(result,'{room,composition}',jsonb_build_object('baker',0)||(result->'room'->'composition'),true);
    end if;
  end if;
  if result ? 'game' and result->'game' is not null then
    select state into g from app_private.games where room_id=target_room;
    if g is not null then
      select count(*) into baker_count from jsonb_array_elements(g->'players') p where p->>'role'='baker';
      bread:=g->>'phase'='morning' and exists(select 1 from jsonb_array_elements(g->'players') p where p->>'role'='baker' and (p->>'alive')::boolean);
      result:=jsonb_set(result,'{game,public,composition,baker}',to_jsonb(baker_count),true);
      result:=jsonb_set(result,'{game,public,breadDelivered}',to_jsonb(bread),true);
    end if;
  end if;
  return result;
end;
$$;

create or replace function public.lobby_command_baker(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; r app_private.rooms%rowtype; me app_private.members%rowtype; comp jsonb; points jsonb; role text; total integer:=0; amount integer; wolves integer;
begin
  if action<>'settings' then
    result:=public.lobby_command(action,payload);
    if result->>'ok'='true' then return app_private.baker_response(result,(result->'room'->>'id')::uuid); end if;
    return result;
  end if;
  perform app_private.assert_site_access();
  if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
  select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
  if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
  select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
  if not found or me.id<>r.host_id or r.status<>'waiting' then raise exception '待機中の主催者だけが設定を変更できます。'; end if;
  if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が更新されました。最新の内容を確認してください。'; end if;
  if coalesce(payload->>'discussionMinutes','') !~ '^[0-9]{1,2}$' or (payload->>'discussionMinutes')::integer not between 1 and 10 then raise exception '議論時間は1〜10分です。'; end if;
  comp:=nullif(payload->'composition','null'::jsonb);
  if comp is not null then
    comp:='{"madman":0,"lover":0,"baker":0}'::jsonb||comp;
    if jsonb_typeof(comp)<>'object' or (select count(*) from jsonb_object_keys(comp))<>8 then raise exception '配役が不正です。'; end if;
    foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker'] loop
      if jsonb_typeof(comp->role) is distinct from 'number' or coalesce(comp->>role,'') !~ '^[0-9]{1,2}$' then raise exception '配役は0以上の整数です。'; end if;
      amount:=(comp->>role)::integer;
      if amount>13 or (role in ('seer','medium','knight','madman','baker') and amount>1) then raise exception '占い師・霊媒師・騎士・狂人・パン屋は各0〜1人です。'; end if;
      total:=total+amount;
    end loop;
    if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
    select count(*) into amount from app_private.members where room_id=r.id;
    wolves:=(comp->>'wolf')::integer;
    if amount<5 or total<>amount or wolves<1 or wolves>=total-wolves then raise exception '配役合計を参加人数に合わせ、人狼を1人以上かつ人間より少なくしてください。'; end if;
  end if;
  points:=coalesce(payload->'victoryPoints',r.victory_points);
  points:=jsonb_build_object('baker',coalesce(points->'baker',r.victory_points->'baker','5'::jsonb))||points;
  if jsonb_typeof(points)<>'object' or (select count(*) from jsonb_object_keys(points))<>8 then raise exception '8役職の勝利点を設定してください。'; end if;
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker'] loop
    if jsonb_typeof(points->role) is distinct from 'number' or coalesce(points->>role,'') !~ '^(10|[0-9])$' then raise exception '勝利点は各役職0〜10の整数で設定してください。'; end if;
  end loop;
  update app_private.rooms set discussion_minutes=(payload->>'discussionMinutes')::integer,composition=comp,victory_points=points,revision=revision+1,updated_at=now() where id=r.id returning * into r;
  update public.room_updates set revision=r.revision where room_id=r.id;
  return app_private.baker_response(app_private.snapshot(r.id),r.id);
end;
$$;

create or replace function public.game_command_baker(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r app_private.rooms%rowtype; me app_private.members%rowtype; g jsonb; comp jsonb; role text; pool text[]:=array[]::text[]; players jsonb:='[]'::jsonb; member record; n integer; total integer:=0; wolves integer; idx integer:=0; at_ms bigint; start_request text; result jsonb;
begin
  if action<>'start' then
    result:=public.game_command(action,payload);
    if result->>'ok'='true' then return app_private.baker_response(result,(payload->>'roomId')::uuid); end if;
    return result;
  end if;
  perform app_private.assert_site_access();
  if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
  select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
  if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
  select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
  if not found or r.host_id<>me.id then raise exception '主催者のみ開始できます。'; end if;
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  start_request:=(payload->>'requestId')::uuid::text;
  if start_request is null then raise exception '操作IDが必要です。'; end if;
  select state into g from app_private.games where room_id=r.id;
  if r.status<>'waiting' then
    if g->>'startRequest'=start_request then return app_private.baker_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id); end if;
    raise exception 'すでにゲームが始まっています。';
  end if;
  if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が変わりました。内容を確認してもう一度開始してください。'; end if;
  select count(*) into n from app_private.members where room_id=r.id;
  if n not between 5 and 13 then raise exception '開始には5〜13人必要です。'; end if;
  comp:='{"madman":0,"lover":0,"baker":0}'::jsonb||coalesce(r.composition,app_private.default_composition(n));
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker'] loop
    if jsonb_typeof(comp->role) is distinct from 'number' or comp->>role !~ '^[0-9]{1,2}$' then raise exception '配役が不正です。'; end if;
    if (comp->>role)::integer>13 or (role in ('seer','medium','knight','madman','baker') and (comp->>role)::integer>1) then raise exception '配役が不正です。'; end if;
    total:=total+(comp->>role)::integer; pool:=pool||array_fill(role,array[(comp->>role)::integer]);
  end loop;
  if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
  wolves:=(comp->>'wolf')::integer;
  if total<>n or wolves<1 or wolves>=n-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
  select array_agg(value order by gen_random_uuid()) into pool from unnest(pool) value;
  for member in select id from app_private.members where room_id=r.id order by seat loop idx:=idx+1;players:=players||jsonb_build_array(jsonb_build_object('id',member.id,'role',pool[idx],'alive',true));end loop;
  g:=jsonb_build_object('id',gen_random_uuid(),'startRequest',start_request,'hostId',r.host_id,'players',players,'phase','roles','phaseId',1,'day',1,'discussionMs',r.discussion_minutes*60000,'deadline',null,'selections','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,'voteResult',null,'victimId',null,'winner',null,'secrets','[]'::jsonb,'removals','[]'::jsonb,'receipts','{}'::jsonb,'scoring',jsonb_build_object('victoryPoints',r.victory_points,'stats','{}'::jsonb));
  insert into app_private.games values(r.id,g) on conflict(room_id) do update set state=excluded.state;
  update app_private.rooms set status='playing',revision=revision+1,updated_at=now() where id=r.id returning * into r;
  update public.room_updates set revision=r.revision where room_id=r.id;
  return app_private.baker_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);
end;
$$;

revoke all on function app_private.validate_victory_points(jsonb),app_private.baker_response(jsonb,uuid),public.lobby_command_baker(text,jsonb),public.game_command_baker(text,jsonb) from public,anon;
grant execute on function public.lobby_command_baker(text,jsonb),public.game_command_baker(text,jsonb) to authenticated;
commit;
