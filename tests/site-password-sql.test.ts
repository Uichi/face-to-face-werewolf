import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const migrations = [
  '202609250001_lobby.sql', '202609270003_game.sql', '202609270004_membership.sql',
  '202609270005_night_immediate.sql', '202609270006_ending.sql', '202609270007_thirteen_players.sql',
  '202609280008_madman.sql', '202609280009_result_confirmation.sql', '202609280010_points.sql',
  '202609280011_lovers.sql'
];

test('サイト共通パスワード: 解除・期限・変更・無効化・直接実行の拒否', async () => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  let accessSql = await readFile(new URL('../supabase/migrations/202609290012_site_password.sql', import.meta.url), 'utf8');
  accessSql = accessSql.replace('create extension if not exists pgcrypto with schema extensions;', () => `
    create function extensions.gen_salt(text,integer) returns text language sql immutable as $$select 'mock-salt'::text$$;
    create function extensions.crypt(input text,salt text) returns text language sql immutable as $$select 'mock:'||input$$;`);
  await db.exec(accessSql);

  const first = randomUUID(); const second = randomUUID(); const requestId = randomUUID();
  await db.query('insert into auth.users values($1),($2)', [first, second]);
  async function role(id: string | null, name = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
    await db.exec(`set role ${name}`);
  }
  async function rpc(name: string, action: string, payload: Record<string, unknown> = {}) {
    return (await db.query<{ data: any }>(`select public.${name}($1,$2::jsonb) data`, [action, JSON.stringify(payload)])).rows[0]!.data;
  }

  await role(first);
  const room = (await rpc('lobby_command', 'create', { nickname: '主催者', requestId })).room;
  assert.equal((await rpc('access_command', 'status')).unlocked, true);

  await db.exec('reset role');
  await db.query("select app_private.configure_site_password('long-password-1')");
  await role(first);
  assert.equal((await rpc('access_command', 'status')).unlocked, false);
  await assert.rejects(rpc('lobby_command', 'heartbeat', { roomId: room.id }), /SITE_ACCESS_REQUIRED/);
  await assert.rejects(rpc('lobby_command_without_site_access', 'heartbeat', { roomId: room.id }), /permission denied/);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await rpc('access_command', 'unlock', { password: 'wrong-password' })).ok, false);
  assert.match((await rpc('access_command', 'unlock', { password: 'long-password-1' })).message, /15分/);
  await db.exec('reset role'); await db.query("delete from app_private.attempts where user_id=$1 and kind='site_password'", [first]); await role(first);
  assert.equal((await rpc('access_command', 'unlock', { password: 'long-password-1' })).ok, true);
  assert.equal((await rpc('lobby_command', 'heartbeat', { roomId: room.id })).ok, true);

  await role(second);
  assert.equal((await rpc('access_command', 'status')).unlocked, false);
  await db.exec('reset role');
  assert.equal((await db.query<{ allowed: boolean }>('select app_private.has_site_access($1) allowed', [second])).rows[0]!.allowed, false);
  await db.query("select app_private.configure_site_password('long-password-2')");
  await role(first);
  assert.equal((await rpc('access_command', 'status')).unlocked, false);
  assert.equal((await rpc('access_command', 'unlock', { password: 'long-password-1' })).ok, false);
  assert.equal((await rpc('access_command', 'unlock', { password: 'long-password-2' })).ok, true);
  await db.exec('reset role');
  await db.query("update app_private.site_access_grants set expires_at=now()-interval '1 second' where user_id=$1", [first]);
  await role(first);
  assert.equal((await rpc('access_command', 'status')).unlocked, false);

  await db.exec('reset role');
  await db.query('select app_private.disable_site_password()');
  await role(second);
  assert.equal((await rpc('access_command', 'status')).unlocked, true);
  await db.close();
});
