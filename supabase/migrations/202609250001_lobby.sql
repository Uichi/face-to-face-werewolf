-- Room membership and lobby settings only. No roles, ballots, or game secrets live here.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table app_private.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-F0-9]{10}$'),
  created_by uuid not null references auth.users(id),
  create_request uuid not null,
  host_id uuid,
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
  discussion_minutes integer not null default 3 check (discussion_minutes between 1 and 10),
  composition jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(created_by, create_request)
);
create table app_private.members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references app_private.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  nickname text not null check (char_length(nickname) between 1 and 20),
  nickname_key text not null,
  seat bigint generated always as identity,
  last_seen timestamptz not null default now(),
  unique(room_id, user_id),
  unique(room_id, nickname_key)
);
alter table app_private.rooms add constraint room_host_fk foreign key(host_id)
  references app_private.members(id) deferrable initially deferred;
create table app_private.attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  bucket timestamptz not null,
  count integer not null,
  primary key(user_id, kind)
);
alter table app_private.rooms enable row level security;
alter table app_private.members enable row level security;
alter table app_private.attempts enable row level security;
revoke all on all tables in schema app_private from public, anon, authenticated;

-- Only a non-secret revision signal is published to Realtime.
create table public.room_updates (
  room_id uuid primary key references app_private.rooms(id) on delete cascade,
  revision bigint not null
);
alter table public.room_updates enable row level security;
revoke all on public.room_updates from public, anon, authenticated;
grant select on public.room_updates to authenticated;

create function app_private.is_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from app_private.members m join app_private.rooms r on r.id = m.room_id
    where m.room_id = target and m.user_id = auth.uid() and r.updated_at > now() - interval '24 hours');
$$;
-- Schema use is needed by the policy, but direct table access is still denied.
grant usage on schema app_private to authenticated;
revoke all on function app_private.is_member(uuid) from public, anon;
grant execute on function app_private.is_member(uuid) to authenticated;
create policy room_member_read on public.room_updates for select to authenticated
  using (app_private.is_member(room_id));

create function app_private.default_composition(n integer) returns jsonb
language sql immutable set search_path = '' as $$
  select case n
    when 5 then '{"villager":3,"wolf":1,"seer":1,"medium":0,"knight":0}'::jsonb
    when 6 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":0}'::jsonb
    when 7 then '{"villager":3,"wolf":1,"seer":1,"medium":1,"knight":1}'::jsonb
    when 8 then '{"villager":3,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 9 then '{"villager":4,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    when 10 then '{"villager":5,"wolf":2,"seer":1,"medium":1,"knight":1}'::jsonb
    else null end;
$$;

create function app_private.snapshot(target uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'room', jsonb_build_object(
    'id', r.id, 'code', r.code, 'hostId', r.host_id, 'status', r.status,
    'revision', r.revision, 'discussionMinutes', r.discussion_minutes,
    'composition', coalesce(r.composition, app_private.default_composition((select count(*)::integer from app_private.members where room_id = r.id))),
    'customComposition', r.composition is not null,
    'viewerId', (select id from app_private.members where room_id = r.id and user_id = auth.uid()),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nickname', m.nickname,
      'connected', m.last_seen > now() - interval '30 seconds') order by m.seat), '[]'::jsonb)
      from app_private.members m where m.room_id = r.id)))
  from app_private.rooms r where r.id = target;
$$;

create function app_private.allow_attempt(kind_in text, limit_in integer, window_in interval) returns boolean
language plpgsql security definer set search_path = '' as $$
declare attempts integer;
begin
  insert into app_private.attempts(user_id, kind, bucket, count)
    values(auth.uid(), kind_in, now(), 1)
  on conflict(user_id, kind) do update set
    bucket = case when app_private.attempts.bucket <= now() - window_in then now() else app_private.attempts.bucket end,
    count = case when app_private.attempts.bucket <= now() - window_in then 1 else app_private.attempts.count + 1 end
  returning count into attempts;
  return attempts <= limit_in;
end;
$$;

create function public.lobby_command(action text, payload jsonb default '{}'::jsonb) returns jsonb
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
    if not found then return jsonb_build_object('ok', false, 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
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
    if not found then return jsonb_build_object('ok', false, 'message', '部屋が見つからないか、有効期限が切れています。'); end if;
    select * into me from app_private.members where room_id = r.id and user_id = uid;
    if not found then return jsonb_build_object('ok', false, 'message', 'この部屋に参加していません。'); end if;
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

revoke all on all functions in schema app_private from public, anon, authenticated;
grant execute on function app_private.is_member(uuid) to authenticated;
revoke all on function public.lobby_command(text, jsonb) from public, anon;
grant execute on function public.lobby_command(text, jsonb) to authenticated;

-- Run every minute through Supabase Cron; never expose this function to players.
create function app_private.cleanup_lobbies() returns void
language sql security definer set search_path = '' as $$
  delete from app_private.rooms where updated_at <= now() - interval '24 hours';
  delete from app_private.attempts where bucket <= now() - interval '24 hours';
$$;
revoke all on function app_private.cleanup_lobbies() from public, anon, authenticated;
