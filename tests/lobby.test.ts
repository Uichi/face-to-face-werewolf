import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Room } from '../src/web/types.ts';

test('待機室SQL: 認証・作成・参加・復帰・権限・人数・設定・期限・主催者移行', async t => {
  const db = new PGlite();
  const ids = Array.from({ length: 15 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  for (const id of ids) await db.query('insert into auth.users values($1)', [id]);
  await db.exec(await readFile(new URL('../supabase/migrations/202609250001_lobby.sql', import.meta.url), 'utf8'));
  async function asUser(id: string | null) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
    await db.exec('set role authenticated');
  }
  async function command(action: string, payload: Record<string, unknown> = {}) {
    const result = await db.query<{ data: { ok: boolean; message?: string; room: Room } }>('select public.lobby_command($1, $2::jsonb) as data', [action, JSON.stringify(payload)]);
    return result.rows[0]!.data;
  }
  let room: Room;
  try {
    await t.test('未認証では操作できない。匿名認証後は自分が主催者の部屋を作成', async () => {
      await asUser(null);
      await assert.rejects(command('create', { nickname: 'ゆう', requestId: ids[0] }));
      await asUser(ids[0]!);
      const result = await command('create', { nickname: 'ゆう', requestId: ids[0] });
      assert.equal(result.ok, true); room = result.room;
      assert.equal(room.members.length, 1); assert.equal(room.hostId, room.viewerId);
      assert.match(room.code, /^[A-F0-9]{10}$/);
      assert.equal(room.composition, null);
      assert.equal(Object.hasOwn(room.members[0]!, 'user_id'), false);
    });
    await t.test('作成の再送では部屋も席も増えない', async () => {
      const retry = await command('create', { nickname: 'ゆう', requestId: ids[0] });
      assert.equal(retry.room.id, room.id); assert.equal(retry.room.members.length, 1);
    });
    await t.test('参加者だけが更新通知を読める。内部テーブル・内部関数・直接書込みは禁止', async () => {
      assert.equal((await db.query('select * from public.room_updates')).rows.length, 1);
      await assert.rejects(db.query('select * from app_private.members'));
      await assert.rejects(db.query('select app_private.snapshot($1)', [room.id]));
      await assert.rejects(db.query('update public.room_updates set revision = 100'));
      await asUser(ids[1]!);
      assert.equal((await db.query('select * from public.room_updates')).rows.length, 0);
      assert.equal((await command('get', { roomId: room.id })).ok, false);
    });
    await t.test('コード参加、名前の重複禁止、再参加は同じ席に戻る', async () => {
      assert.equal((await command('join', { code: room.code, nickname: 'ゆう' })).ok, false);
      const result = await command('join', { code: room.code.toLowerCase(), nickname: 'Ａｏｉ' });
      assert.equal(result.ok, true); assert.equal(result.room.members[1]!.nickname, 'Aoi');
      assert.equal((await db.query('select * from public.room_updates')).rows.length, 1);
      const retry = await command('join', { code: room.code, nickname: '別名' });
      assert.equal(retry.room.viewerId, result.room.viewerId); assert.equal(retry.room.members.length, 2);
      await asUser(ids[2]!);
      assert.equal((await command('join', { code: room.code, nickname: 'aoi' })).ok, false);
    });
    await t.test('5人で標準配役を表示、主催者のみ変更可、古い版と不正配役を拒否', async () => {
      for (let i = 2; i < 5; i++) {
        await asUser(ids[i]!); const result = await command('join', { code: room.code, nickname: `参加者${i}` });
        assert.equal(result.ok, true); room = result.room;
      }
      assert.equal(room.composition!.wolf, 1); assert.equal(room.composition!.villager, 3);
      assert.equal((await command('settings', { roomId: room.id, revision: room.revision, discussionMinutes: 4 })).ok, false);
      await asUser(ids[0]!);
      assert.equal((await command('settings', { roomId: room.id, revision: 1, discussionMinutes: 4 })).ok, false);
      assert.equal((await command('settings', { roomId: room.id, revision: room.revision, discussionMinutes: 0 })).ok, false);
      assert.equal((await command('settings', { roomId: room.id, revision: room.revision, discussionMinutes: 3, composition: { villager: 1, wolf: 3, seer: 1, medium: 0, knight: 0 } })).ok, false);
      assert.equal((await command('settings', { roomId: room.id, revision: room.revision, discussionMinutes: 3, composition: { villager: '3', wolf: 1, seer: 1, medium: 0, knight: 0 } })).ok, false);
      const result = await command('settings', { roomId: room.id, revision: room.revision, discussionMinutes: 4, composition: { villager: 2, wolf: 1, seer: 1, medium: 1, knight: 0 } });
      assert.equal(result.ok, true); room = result.room;
      assert.equal(room.discussionMinutes, 4); assert.equal(room.customComposition, true);
    });
    await t.test('10人を超える参加は拒否し、11人目の席を作らない', async () => {
      for (let i = 5; i < 10; i++) {
        await asUser(ids[i]!); assert.equal((await command('join', { code: room.code, nickname: `参加者${i}` })).ok, true);
      }
      await asUser(ids[10]!); assert.equal((await command('join', { code: room.code, nickname: '11人目' })).ok, false);
    });
    await t.test('開始後の新規参加は不可、既存参加者の復帰は可', async () => {
      await db.exec('reset role'); await db.query("update app_private.rooms set status = 'playing' where id = $1", [room.id]);
      await asUser(ids[10]!); assert.equal((await command('join', { code: room.code, nickname: '途中参加' })).ok, false);
      await asUser(ids[1]!); assert.equal((await command('join', { code: room.code, nickname: 'Aoi' })).ok, true);
    });
    await t.test('主催者60秒切断時は接続中の入室順、旧主催者の復帰で奪い返さない', async () => {
      await db.exec('reset role');
      await db.query("update app_private.members set last_seen = now() - interval '61 seconds' where room_id = $1", [room.id]);
      await db.query('update app_private.members set last_seen = now() where room_id = $1 and user_id = $2', [room.id, ids[1]]);
      await asUser(ids[2]!);
      const moved = await command('heartbeat', { roomId: room.id });
      assert.equal(moved.room.hostId, moved.room.members[1]!.id);
      await asUser(ids[0]!); const returned = await command('heartbeat', { roomId: room.id });
      assert.equal(returned.room.hostId, moved.room.hostId);
      assert.equal(returned.room.members.length, 10);
    });
    await t.test('存在しないコードの失敗試行も回数制限に数える', async () => {
      await asUser(ids[11]!);
      for (let i = 0; i < 20; i++) assert.equal((await command('join', { code: '0000000000', nickname: 'テスト' })).ok, false);
      assert.match((await command('join', { code: room.code, nickname: 'テスト' })).message!, /試行が多い/);
    });
    await t.test('部屋作成を1時間に3件までに制限する', async () => {
      await asUser(ids[12]!);
      for (let i = 0; i < 3; i++) assert.equal((await command('create', { nickname: '作成者', requestId: ids[i] })).ok, true);
      assert.match((await command('create', { nickname: '作成者', requestId: ids[3] })).message!, /作成回数/);
    });
    await t.test('24時間経過した部屋は復帰不可。清掃で席と通知も削除', async () => {
      await db.exec('reset role'); await db.query("update app_private.rooms set updated_at = now() - interval '25 hours' where id = $1", [room.id]);
      await asUser(ids[0]!); assert.equal((await command('heartbeat', { roomId: room.id })).ok, false);
      assert.equal((await db.query('select * from public.room_updates where room_id = $1', [room.id])).rows.length, 0);
      await assert.rejects(db.query('select app_private.cleanup_lobbies()'));
      await db.exec('reset role'); await db.query('select app_private.cleanup_lobbies()');
      assert.equal((await db.query('select * from app_private.members where room_id = $1', [room.id])).rows.length, 0);
      assert.equal((await db.query('select * from public.room_updates where room_id = $1', [room.id])).rows.length, 0);
    });
  } finally { await db.close(); }
});
