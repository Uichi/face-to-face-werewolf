begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table app_private.site_access_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  password_hash text,
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  check ((not enabled and password_hash is null) or (enabled and password_hash is not null))
);
create table app_private.site_access_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table app_private.site_access_config enable row level security;
alter table app_private.site_access_grants enable row level security;
revoke all on app_private.site_access_config,app_private.site_access_grants from public,anon,authenticated;
insert into app_private.site_access_config(singleton) values(true) on conflict(singleton) do nothing;

create function app_private.has_site_access(uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select not c.enabled or (uid is not null and exists(
    select 1 from app_private.site_access_grants g
    where g.user_id=uid and g.version=c.version and g.expires_at>now()
  )) from app_private.site_access_config c where c.singleton;
$$;

create function app_private.assert_site_access() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(app_private.has_site_access(auth.uid()),false) then
    raise exception using errcode='P0001',message='SITE_ACCESS_REQUIRED';
  end if;
end;
$$;

create function public.access_command(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); c app_private.site_access_config%rowtype; supplied text;
begin
  if action not in ('status','unlock') or jsonb_typeof(payload)<>'object' then raise exception '操作が不正です'; end if;
  select * into c from app_private.site_access_config where singleton;
  if action='status' then
    return jsonb_build_object('ok',true,'enabled',c.enabled,'unlocked',not c.enabled or app_private.has_site_access(uid),
      'expiresAt',(select g.expires_at from app_private.site_access_grants g where g.user_id=uid and g.version=c.version and g.expires_at>now()));
  end if;
  if uid is null then raise exception 'ログインが必要です'; end if;
  if not c.enabled then return jsonb_build_object('ok',true,'enabled',false,'unlocked',true); end if;
  if not app_private.allow_attempt('site_password',5,interval '15 minutes') then
    return jsonb_build_object('ok',false,'enabled',true,'unlocked',false,'message','入力回数が多いため、15分ほど待ってからお試しください。');
  end if;
  supplied:=coalesce(payload->>'password','');
  if extensions.crypt(supplied,c.password_hash)<>c.password_hash then
    return jsonb_build_object('ok',false,'enabled',true,'unlocked',false,'message','合言葉が違います。もう一度確認してください。');
  end if;
  insert into app_private.site_access_grants(user_id,version,expires_at)
    values(uid,c.version,now()+interval '30 days')
    on conflict(user_id) do update set version=excluded.version,expires_at=excluded.expires_at,created_at=now();
  delete from app_private.attempts where user_id=uid and kind='site_password';
  return jsonb_build_object('ok',true,'enabled',true,'unlocked',true,'expiresAt',now()+interval '30 days');
end;
$$;

create function app_private.configure_site_password(password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  if octet_length(password) not between 12 and 72 then raise exception '合言葉は12〜72バイトで設定してください。'; end if;
  update app_private.site_access_config set enabled=true,password_hash=extensions.crypt(password,extensions.gen_salt('bf',12)),version=version+1,updated_at=now()
    where singleton returning version into next_version;
  delete from app_private.site_access_grants;
  return jsonb_build_object('ok',true,'enabled',true,'version',next_version);
end;
$$;

create function app_private.disable_site_password() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare next_version bigint;
begin
  update app_private.site_access_config set enabled=false,password_hash=null,version=version+1,updated_at=now()
    where singleton returning version into next_version;
  delete from app_private.site_access_grants;
  return jsonb_build_object('ok',true,'enabled',false,'version',next_version);
end;
$$;

alter function public.lobby_command(text,jsonb) rename to lobby_command_without_site_access;
alter function public.game_command(text,jsonb) rename to game_command_without_site_access;
alter function public.membership_command(text,jsonb) rename to membership_command_without_site_access;
alter function public.score_command(text,jsonb) rename to score_command_without_site_access;

create function public.lobby_command(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform app_private.assert_site_access();return public.lobby_command_without_site_access(action,payload);end$$;
create function public.game_command(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform app_private.assert_site_access();return public.game_command_without_site_access(action,payload);end$$;
create function public.membership_command(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform app_private.assert_site_access();return public.membership_command_without_site_access(action,payload);end$$;
create function public.score_command(action text,payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform app_private.assert_site_access();return public.score_command_without_site_access(action,payload);end$$;

create or replace function app_private.is_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.has_site_access(auth.uid()) and exists(select 1 from app_private.members m join app_private.rooms r on r.id=m.room_id
    where m.room_id=target and m.user_id=auth.uid() and r.updated_at>now()-interval '24 hours');
$$;

revoke all on function app_private.has_site_access(uuid),app_private.assert_site_access(),app_private.configure_site_password(text),app_private.disable_site_password() from public,anon,authenticated;
revoke all on function public.lobby_command_without_site_access(text,jsonb),public.game_command_without_site_access(text,jsonb),public.membership_command_without_site_access(text,jsonb),public.score_command_without_site_access(text,jsonb) from public,anon,authenticated;
revoke all on function public.access_command(text,jsonb),public.lobby_command(text,jsonb),public.game_command(text,jsonb),public.membership_command(text,jsonb),public.score_command(text,jsonb) from public,anon,authenticated;
grant execute on function public.access_command(text,jsonb) to anon,authenticated;
grant execute on function public.lobby_command(text,jsonb),public.game_command(text,jsonb),public.membership_command(text,jsonb),public.score_command(text,jsonb) to authenticated;

commit;
