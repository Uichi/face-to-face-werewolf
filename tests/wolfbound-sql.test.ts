import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrations = [
  '202609250001_lobby.sql','202609270003_game.sql','202609270004_membership.sql','202609270005_night_immediate.sql',
  '202609270006_ending.sql','202609270007_thirteen_players.sql','202609280008_madman.sql','202609280009_result_confirmation.sql',
  '202609280010_points.sql','202609280011_lovers.sql','202609290013_baker.sql','202609290014_first_day_no_execution.sql',
  '202609290015_public_log.sql','202609290016_thief.sql','202609290017_thief_result.sql','202609300018_host_result_progress.sql',
  '202609300019_bread_choices.sql','202609300020_consecutive_guard.sql','202610010021_wolfbound.sql',
];

test('狼憑きSQL: 設定・開始時抽選・秘密情報・旧操作口の無効化', async () => {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;
    create schema extensions;
    create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;
    create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(lpad(to_hex(floor(random()*256)::integer),2,'0'),'hex')$$;`);
  for (const name of migrations) {
    if (name === '202609290013_baker.sql') await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const users = Array.from({ length: 5 }, () => randomUUID());
  await db.exec('reset role');
  for (const id of users) await db.query('insert into auth.users values($1)', [id]);
  const use = async (id: string) => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role authenticated'); };
  const call = async (fn: string, action: string, payload: Record<string, unknown>) => (await db.query<{ data: any }>(`select public.${fn}($1,$2::jsonb)data`, [action, JSON.stringify(payload)])).rows[0]!.data;

  await use(users[0]!);
  let response = await call('lobby_command_wolfbound', 'create', { nickname: '主催者', requestId: randomUUID() });
  for (let i = 1; i < users.length; i++) {
    await use(users[i]!);
    response = await call('lobby_command_wolfbound', 'join', { code: response.room.code, nickname: `参加者${i}` });
  }
  await use(users[0]!);
  response = await call('lobby_command_wolfbound', 'settings', { roomId: response.room.id, revision: response.room.revision, discussionMinutes: 3, wolfboundEnabled: true });
  assert.equal(response.room.wolfboundEnabled, true);
  response = await call('game_command_wolfbound', 'start', { roomId: response.room.id, revision: response.room.revision, requestId: randomUUID() });
  assert.equal(response.game.public.phase, 'roles');
  assert.equal(JSON.stringify(response.game).includes('wolfbound'), false);

  await db.exec('reset role');
  const state = (await db.query<{ state: { players: Array<{ role: string; wolfbound?: boolean; initialWolfbound?: boolean }> } }>('select state from app_private.games where room_id=$1', [response.room.id])).rows[0]!.state;
  const marked = state.players.filter(player => player.wolfbound);
  assert.ok(marked.length === 0 || marked.length === 1);
  if (marked[0]) {
    assert.equal(marked[0].role, 'villager');
    assert.equal(marked[0].initialWolfbound, true);
  }

  // Force one marked villager so the secrecy assertion never depends on the random 50% roll.
  await db.query(`update app_private.games set state=jsonb_set(state,'{players}',(
    select jsonb_agg(case when p->>'id'=(select q->>'id' from jsonb_array_elements(state->'players')q where q->>'role'='villager' limit 1)
      then p||'{"wolfbound":true,"initialWolfbound":true}'::jsonb else p end)from jsonb_array_elements(state->'players')p),true)where room_id=$1`, [response.room.id]);
  await use(users[0]!);
  response = await call('game_command_wolfbound', 'get', { roomId: response.room.id });
  assert.equal(JSON.stringify(response.game).includes('wolfbound'), false);

  await assert.rejects(() => call('game_command_guard', 'get', { roomId: response.room.id }), /permission denied/);
  await db.close();
});
