-- Add waiting-room removal and voluntary leave. Run this entire file in SQL Editor.
begin;
create or replace function public.membership_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r app_private.rooms%rowtype; me app_private.members%rowtype; target uuid; candidate uuid;
begin
 if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
 if action is null or action not in ('remove','leave') or jsonb_typeof(payload) is distinct from 'object' then raise exception '操作が不正です。'; end if;
 -- Same lock order as lobby_command; room lock also serializes game start.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid for update;
 if not found then
   if action='leave' then return jsonb_build_object('ok',true,'left',true); end if;
   raise exception '部屋が見つかりません。';
 end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then
   if action='leave' then return jsonb_build_object('ok',true,'left',true); end if;
   raise exception 'この部屋に参加していません。';
 end if;
 if (payload->>'memberId')::uuid is distinct from me.id then raise exception '参加情報が変わりました。ページを更新してください。'; end if;
 if r.status<>'waiting' then raise exception '参加者の削除・退出は待機室で行ってください。試合終了後は再戦で待機室に戻れます。'; end if;
 if action='remove' then
   if r.host_id<>me.id then raise exception '主催者だけが参加者を削除できます。'; end if;
   target:=(payload->>'targetId')::uuid;
   if target is null or target=me.id then raise exception '自分の席は「部屋から退出する」で削除してください。'; end if;
   -- Exact seat IDs make retries harmless, including after the same user rejoins.
   if not exists(select 1 from app_private.members where room_id=r.id and id=target) then return app_private.snapshot(r.id); end if;
 else target:=me.id;
 end if;
 if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が変わりました。最新の内容を確認してもう一度操作してください。'; end if;
 if target=r.host_id then
   select id into candidate from app_private.members where room_id=r.id and id<>target
     order by (last_seen>now()-interval '30 seconds') desc, seat limit 1;
   update app_private.rooms set host_id=candidate where id=r.id;
 end if;
 delete from app_private.members where room_id=r.id and id=target;
 if not exists(select 1 from app_private.members where room_id=r.id) then
   delete from app_private.rooms where id=r.id;
   return jsonb_build_object('ok',true,'left',true);
 end if;
 -- The previous custom composition no longer matches the roster.
 update app_private.rooms set composition=null,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 update public.room_updates set revision=r.revision where room_id=r.id;
 if action='leave' then return jsonb_build_object('ok',true,'left',true); end if;
 return app_private.snapshot(r.id);
end;
$$;
revoke all on function public.membership_command(text,jsonb) from public,anon;
grant execute on function public.membership_command(text,jsonb) to authenticated;

-- Keep create retries from exposing a room after its creator has left.
create or replace function public.lobby_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); r app_private.rooms%rowtype; me app_private.members%rowtype;
  name text; code_in text; candidate uuid; amount integer; minutes integer;
  comp jsonb; key text; total integer := 0; wolves integer; changed boolean := false;
begin
  if uid is null then raise exception 'ログインが必要です'; end if;
  if action not in ('create', 'join', 'get', 'heartbeat', 'settings') then raise exception '操作が不正です'; end if;
  if jsonb_typeof(payload) <> 'object' then raise exception '操作が不正です'; end if;
  -- Serialize requests made by the same anonymous identity, including create retries.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  if action in ('create', 'join') then
    name := btrim(regexp_replace(normalize(coalesce(payload->>'nickname', ''), NFKC), '\s+', ' ', 'g'));
    if char_length(name) not between 1 and 20 or name ~ '[[:cntrl:]]' then
      return jsonb_build_object('ok', false, 'message', '名前は1〜20文字で入力してください。');
    end if;
  end if;

  if action = 'create' then
    select * into r from app_private.rooms where created_by = uid and create_request = (payload->>'requestId')::uuid;
    if found then
      if r.updated_at <= now() - interval '24 hours' then
        return jsonb_build_object('ok', false, 'message', 'この部屋の有効期限が切れました。');
      end if;
      if not exists(select 1 from app_private.members where room_id=r.id and user_id=uid) then
        return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', 'この部屋から退出しています。招待コードで参加し直してください。');
      end if;
      return app_private.snapshot(r.id);
    end if;
    if not app_private.allow_attempt('create', 3, interval '1 hour') then
      return jsonb_build_object('ok', false, 'message', '部屋の作成回数が多いため、しばらく待ってください。');
    end if;
    -- 40 random bits, with collision retry. Joining is separately rate-limited.
    loop
      begin
        insert into app_private.rooms(code, created_by, create_request)
          values(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), uid, (payload->>'requestId')::uuid)
          returning * into r;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    insert into app_private.members(room_id, user_id, nickname, nickname_key) values(r.id, uid, name, lower(name)) returning * into me;
    update app_private.rooms set host_id = me.id where id = r.id;
    insert into public.room_updates values(r.id, r.revision);
    return app_private.snapshot(r.id);
  end if;

  if action = 'join' then
    if not app_private.allow_attempt('join', 20, interval '10 minutes') then
      return jsonb_build_object('ok', false, 'message', '参加の試行が多いため、しばらく待ってください。');
    end if;
    code_in := upper(regexp_replace(coalesce(payload->>'code', ''), '[\s-]', '', 'g'));
    select * into r from app_private.rooms where code = code_in and updated_at > now() - interval '24 hours' for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
    select * into me from app_private.members where room_id = r.id and user_id = uid;
    if found then
      update app_private.members set last_seen = now() where id = me.id;
      return app_private.snapshot(r.id);
    end if;
    if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'message', '開始後の部屋には参加できません。'); end if;
    select count(*) into amount from app_private.members where room_id = r.id;
    if amount >= 10 then return jsonb_build_object('ok', false, 'message', 'この部屋は満員です。'); end if;
    if exists(select 1 from app_private.members where room_id = r.id and nickname_key = lower(name)) then
      return jsonb_build_object('ok', false, 'message', '同じ名前の人がいます。別の名前にしてください。');
    end if;
    insert into app_private.members(room_id, user_id, nickname, nickname_key) values(r.id, uid, name, lower(name)) returning * into me;
    changed := true;
  else
    select * into r from app_private.rooms where id = (payload->>'roomId')::uuid and updated_at > now() - interval '24 hours' for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
    select * into me from app_private.members where room_id = r.id and user_id = uid;
    if not found then return jsonb_build_object('ok', false, 'code', 'ROOM_ACCESS_LOST', 'message', 'この部屋の参加者から外れました。招待コードから参加し直せます。'); end if;
  end if;

  if action = 'heartbeat' then
    update app_private.members set last_seen = now() where id = me.id;
    if exists(select 1 from app_private.members where id = r.host_id and last_seen <= now() - interval '60 seconds') then
      select id into candidate from app_private.members where room_id = r.id and last_seen > now() - interval '30 seconds' order by seat limit 1;
      if candidate is not null and candidate <> r.host_id then
        update app_private.rooms set host_id = candidate where id = r.id;
        changed := true;
      end if;
    end if;
  end if;

  if action = 'settings' then
    if r.host_id <> me.id or r.status <> 'waiting' then
      return jsonb_build_object('ok', false, 'message', '待機中の主催者だけが設定を変更できます。');
    end if;
    if (payload->>'revision')::bigint is distinct from r.revision then
      return jsonb_build_object('ok', false, 'message', '参加者や設定が更新されました。最新の内容を確認してください。');
    end if;
    if coalesce(payload->>'discussionMinutes', '') !~ '^[0-9]{1,2}$' then
      return jsonb_build_object('ok', false, 'message', '議論時間は1〜10分です。');
    end if;
    minutes := (payload->>'discussionMinutes')::integer;
    if minutes not between 1 and 10 then return jsonb_build_object('ok', false, 'message', '議論時間は1〜10分です。'); end if;
    comp := nullif(payload->'composition', 'null'::jsonb);
    if comp is not null then
      if jsonb_typeof(comp) <> 'object' then return jsonb_build_object('ok', false, 'message', '配役が不正です。'); end if;
      if (select count(*) from jsonb_object_keys(comp)) <> 5 then return jsonb_build_object('ok', false, 'message', '配役が不正です。'); end if;
      foreach key in array array['villager','wolf','seer','medium','knight'] loop
        if jsonb_typeof(comp->key) is distinct from 'number' or coalesce(comp->>key, '') !~ '^[0-9]{1,2}$' then return jsonb_build_object('ok', false, 'message', '配役は0以上の整数です。'); end if;
        amount := (comp->>key)::integer;
        if amount > 10 or (key in ('seer','medium','knight') and amount > 1) then return jsonb_build_object('ok', false, 'message', '能力職は各0〜1人です。'); end if;
        total := total + amount;
      end loop;
      wolves := (comp->>'wolf')::integer;
      select count(*) into amount from app_private.members where room_id = r.id;
      if amount < 5 or total <> amount or wolves < 1 or wolves >= total - wolves then
        return jsonb_build_object('ok', false, 'message', '配役合計を参加人数に合わせ、人狼を1人以上かつ村側より少なくしてください。');
      end if;
    end if;
    update app_private.rooms set discussion_minutes = minutes, composition = comp where id = r.id;
    changed := true;
  end if;

  if changed then
    update app_private.rooms set revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    update public.room_updates set revision = r.revision where room_id = r.id;
  end if;
  return app_private.snapshot(r.id);
end;
$$;
commit;
