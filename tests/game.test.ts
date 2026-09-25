import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Command } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';

function fixture(count = 5) {
  const ids = count === 5 ? ['v0', 'v1', 'v2', 'w', 's']
    : count === 7 ? ['v0', 'v1', 'v2', 'w', 's', 'm', 'k']
    : ['v0', 'v1', 'v2', 'w0', 'w1', 's', 'm', 'k'];
  let game = createGame({ id: 'game-1', hostId: 'v0', playerIds: ids, composition: DEFAULT_COMPOSITIONS[count]! }, 0, () => 0);
  let sequence = 0;
  let now = 0;
  const send = (actorId: string | null, action: Command['action']) => {
    game = applyCommand(game, { actorId, action, gameId: game.id, phaseId: game.phaseId, requestId: String(++sequence) }, now, () => 0);
    return game;
  };
  const confirmAll = () => {
    for (const p of game.players.filter(p => p.alive)) send(p.id, { type: 'confirm' });
  };
  const day = () => { confirmAll(); confirmAll(); assert.equal(game.phase, 'discussion'); };
  const vote = (choices: Record<string, string>) => {
    for (const [actorId, targetId] of Object.entries(choices)) {
      send(actorId, { type: 'select', targetId });
      send(actorId, { type: 'confirm' });
    }
  };
  return { get game() { return game; }, send, confirmAll, day, vote,
    time(value: number) { now = value; }, tick() { return send(null, { type: 'tick' }); } };
}

function toNight(f: ReturnType<typeof fixture>) {
  f.day();
  f.send('v0', { type: 'startVote' });
  const votes = Object.fromEntries(f.game.players.map(p => [p.id, p.id === 'v2' ? 'v1' : 'v2']));
  f.vote(votes);
  assert.equal(f.game.phase, 'execution');
  f.send('v0', { type: 'next' });
  assert.equal(f.game.phase, 'night');
}

test('全員の役職確認→初夜→全員確認で即座に昼、白通知は占い師だけ', () => {
  const f = fixture();
  assert.equal(f.game.phase, 'roles');
  assert.equal(viewFor(f.game, 's').private!.results.length, 0);
  f.confirmAll();
  assert.equal(f.game.phase, 'firstNight');
  assert.equal(f.game.deadline, null);
  assert.deepEqual(viewFor(f.game, 's').private!.results.map(r => r.targetId), ['v0']);
  assert.equal(viewFor(f.game, 'v0').private!.results.length, 0);
  f.confirmAll();
  assert.equal(f.game.phase, 'discussion');
  assert.equal(f.game.deadline, 180_000);
});

test('議論の時間切れで投票、投票時間切れでは自動投票せず延長・遅い操作を受理', () => {
  const f = fixture(); f.day(); f.time(180_000); f.tick();
  assert.equal(f.game.phase, 'vote');
  f.time(250_000); f.tick();
  assert.equal(f.game.phase, 'vote');
  assert.equal(f.game.confirmed.length, 0);
  f.send('v0', { type: 'extend' });
  assert.equal(f.game.deadline, 310_000);
  f.vote({ v0: 'w', v1: 'w', v2: 'w', w: 'v0', s: 'w' });
  assert.equal(f.game.phase, 'finished');
  assert.equal(f.game.winner, 'village');
});

test('選択は変更可、確定後は変更不可。主催者権限と未選択の確定を検証', () => {
  const f = fixture(); f.day();
  assert.throws(() => f.send('v1', { type: 'startVote' }));
  f.send('v0', { type: 'extend' }); assert.equal(f.game.deadline, 240_000);
  f.send('v0', { type: 'startVote' });
  assert.throws(() => f.send('v0', { type: 'confirm' }));
  f.send('v0', { type: 'select', targetId: 'v1' });
  f.send('v0', { type: 'select', targetId: 'v2' });
  f.send('v0', { type: 'confirm' });
  assert.throws(() => f.send('v0', { type: 'select', targetId: 'w' }));
  assert.equal(viewFor(f.game, 'v1').private!.selection, null);
  assert.equal(viewFor(f.game, 'v1').public.completedCount, 1);
  assert.equal(viewFor(f.game, 'v1').public.voteResult, null);
});

test('同票→決選で候補者も投票し自己投票不可、再同票なら処刑なし', () => {
  const f = fixture(); f.day(); f.send('v0', { type: 'startVote' });
  f.vote({ v0: 'v1', v1: 'v0', v2: 'v0', w: 'v1', s: 'v2' });
  assert.equal(f.game.phase, 'runoff');
  assert.deepEqual(f.game.runoffIds, ['v0', 'v1']);
  assert.throws(() => f.send('v0', { type: 'select', targetId: 'v0' }));
  assert.throws(() => f.send('v2', { type: 'select', targetId: 's' }));
  f.vote({ v0: 'v1', v1: 'v0', v2: 'v0', w: 'v1', s: 'v0' });
  assert.equal(f.game.phase, 'execution');
  assert.equal(f.game.voteResult!.executedId, 'v0');
  // A dead host retains progression rights.
  f.send('v0', { type: 'next' }); assert.equal(f.game.phase, 'night');

  const g = fixture(); g.day(); g.send('v0', { type: 'remove', targetId: 'v2' });
  g.send('v0', { type: 'startVote' });
  const tied = { v0: 'v1', v1: 'v0', w: 'v0', s: 'v1' };
  g.vote(tied); g.vote(tied);
  assert.equal(g.game.phase, 'execution');
  assert.equal(g.game.voteResult!.executedId, null);
  assert.equal(g.game.players.filter(p => p.alive).length, 4);
});

test('夜は能力なしの確認も必要、全員完了しても60秒まで待つ', () => {
  const f = fixture(); toNight(f);
  f.send('w', { type: 'select', targetId: 'v1' }); f.send('w', { type: 'confirm' });
  f.send('s', { type: 'select', targetId: 'w' }); f.send('s', { type: 'confirm' });
  f.send('v0', { type: 'confirm' }); f.send('v1', { type: 'confirm' });
  assert.equal(f.game.phase, 'night');
  f.time(59_999); f.tick(); assert.equal(f.game.phase, 'night');
  f.time(60_000); f.tick(); assert.equal(f.game.phase, 'morning');
  assert.equal(f.game.victimId, 'v1'); assert.equal(f.game.day, 2);
  assert.equal(viewFor(f.game, 's').private!.results.at(-1)!.isWolf, true);
  f.send('v0', { type: 'next' }); assert.equal(f.game.phase, 'discussion');
  f.send('v0', { type: 'startVote' });
  f.vote({ v0: 'w', w: 'v0', s: 'w' });
  assert.equal(f.game.winner, 'village');
});

test('夜の時間切れ後も未操作者を待ち、最後の確認で処理する', () => {
  const f = fixture(); toNight(f); f.time(90_000); f.tick();
  assert.equal(f.game.phase, 'night'); assert.equal(f.game.victimId, null);
  f.send('w', { type: 'select', targetId: 'v1' }); f.send('w', { type: 'confirm' });
  f.send('s', { type: 'select', targetId: 'w' }); f.send('s', { type: 'confirm' });
  f.send('v0', { type: 'confirm' }); assert.equal(f.game.phase, 'night');
  f.send('v1', { type: 'confirm' }); assert.equal(f.game.phase, 'morning');
});

test('投票途中の脱落で全票取消、60秒リセット、旧段階を拒否', () => {
  const f = fixture(); f.day(); f.send('v0', { type: 'startVote' });
  f.send('v1', { type: 'select', targetId: 'v2' }); f.send('v1', { type: 'confirm' });
  const oldId = f.game.phaseId;
  f.time(40_000); f.send('v0', { type: 'remove', targetId: 'v2' });
  assert.equal(f.game.phase, 'vote'); assert.equal(f.game.deadline, 100_000);
  assert.deepEqual(f.game.selections, {}); assert.deepEqual(f.game.confirmed, []);
  assert.equal(f.game.voteResult, null);
  assert.throws(() => applyCommand(f.game, { gameId: f.game.id, phaseId: oldId, requestId: 'late', actorId: 'v1', action: { type: 'confirm' } }, 40_000, () => 0));
  assert.throws(() => f.send('v2', { type: 'confirm' }));
  assert.equal(viewFor(f.game, 'v2').private, null);
});

test('決選候補の脱落で通常投票へ戻る', () => {
  const f = fixture(); f.day(); f.send('v0', { type: 'startVote' });
  f.vote({ v0: 'v1', v1: 'v0', v2: 'v0', w: 'v1', s: 'v2' });
  f.send('v0', { type: 'remove', targetId: 'v1' });
  assert.equal(f.game.phase, 'vote'); assert.deepEqual(f.game.runoffIds, []);
  assert.equal(f.game.voteResult, null);
  f.send('v2', { type: 'select', targetId: 's' });
});

test('夜途中の脱落は占い・護衛・襲撃・確認を全取消し、新しい段階で再確定', () => {
  const f = fixture(7); toNight(f);
  f.send('w', { type: 'select', targetId: 'v1' }); f.send('w', { type: 'confirm' });
  f.send('s', { type: 'select', targetId: 'w' }); f.send('s', { type: 'confirm' });
  f.send('k', { type: 'select', targetId: 'v1' }); f.send('k', { type: 'confirm' });
  const old = f.game.phaseId; const secrets = structuredClone(f.game.secrets);
  f.time(30_000); f.send('v0', { type: 'remove', targetId: 'v1' });
  assert.equal(f.game.phase, 'night'); assert.ok(f.game.phaseId > old);
  assert.equal(f.game.deadline, 90_000); assert.deepEqual(f.game.selections, {});
  assert.deepEqual(f.game.confirmed, []); assert.deepEqual(f.game.secrets, secrets);
  f.send('w', { type: 'select', targetId: 'v0' });
  f.send('s', { type: 'select', targetId: 'w' });
  f.send('k', { type: 'select', targetId: 'v0' }); f.confirmAll();
  f.time(90_000); f.tick();
  assert.equal(f.game.phase, 'morning'); assert.equal(f.game.victimId, null);
});

test('初夜中の脱落は白通知と既存確認を保持し、残り全員確認で即進行', () => {
  const f = fixture(); f.confirmAll();
  f.send('v0', { type: 'confirm' }); f.send('v1', { type: 'confirm' });
  f.send('w', { type: 'confirm' }); f.send('s', { type: 'confirm' });
  const secrets = structuredClone(f.game.secrets);
  f.send('v0', { type: 'remove', targetId: 'v2' });
  assert.equal(f.game.phase, 'discussion'); assert.deepEqual(f.game.secrets, secrets);
  assert.equal(f.game.players.find(p => p.id === 'v2')!.alive, false);
});

test('途中脱落で勝敗成立なら直ちに終了し、追加の操作不可', () => {
  const f = fixture(); f.send('v0', { type: 'remove', targetId: 'w' });
  assert.equal(f.game.phase, 'finished'); assert.equal(f.game.winner, 'village');
  assert.throws(() => f.send('v0', { type: 'next' }));
  assert.ok(viewFor(f.game, 'v0').public.players.every(p => p.role));
  assert.equal(viewFor(f.game, 'v0').private, null);
  assert.equal(viewFor(f.game, 'w').wolves, null);
});

test('二重送信は段階が進んだ後でも無変更、ID使い回し・別試合・偽tickを拒否', () => {
  const f = fixture();
  for (const id of ['v0', 'v1', 'v2', 'w']) f.send(id, { type: 'confirm' });
  const command: Command = { gameId: f.game.id, phaseId: f.game.phaseId, requestId: 'last', actorId: 's', action: { type: 'confirm' } };
  const before = structuredClone(f.game);
  const after = applyCommand(f.game, command, 0, () => 0);
  assert.equal(after.phase, 'firstNight'); assert.deepEqual(f.game, before);
  assert.deepEqual(applyCommand(after, command, 1, () => { throw Error('rerolled'); }), after);
  assert.throws(() => applyCommand(after, { ...command, action: { type: 'select', targetId: 'w' } }, 1, () => 0));
  assert.throws(() => applyCommand(after, { ...command, gameId: 'another' }, 1, () => 0));
  assert.throws(() => f.send('v0', { type: 'tick' }));
});

test('生存人狼のみ仲間の選択を見られ、脱落者・主催者へ秘密情報を渡さない', () => {
  const f = fixture(8); toNight(f);
  f.send('w0', { type: 'select', targetId: 'v1' });
  assert.equal(viewFor(f.game, 'w1').wolves!.selections.find(s => s.actorId === 'w0')!.targetId, 'v1');
  assert.equal(viewFor(f.game, 'v0').wolves, null);
  assert.equal(viewFor(f.game, 'v0').public.players.some(p => 'role' in p), false);
  assert.equal(viewFor(f.game, 'v2').private, null);
  f.send('v0', { type: 'remove', targetId: 'w0' });
  assert.equal(viewFor(f.game, 'w0').wolves, null);
  assert.throws(() => viewFor(f.game, 'outsider'));
  const view = viewFor(f.game, 'w1'); view.public.players[0]!.alive = false;
  assert.equal(f.game.players[0]!.alive, true);
});

test('占い師襲撃の結果は内部で成立するが、脱落後は公開情報だけ返す', () => {
  const f = fixture(); toNight(f);
  f.send('w', { type: 'select', targetId: 's' });
  f.send('s', { type: 'select', targetId: 'w' }); f.confirmAll();
  f.time(60_000); f.tick();
  assert.equal(f.game.secrets.at(-1)!.isWolf, true);
  assert.equal(viewFor(f.game, 's').private, null);
});

test('初夜前の脱落でも生存者の確認で進み、役職は再配布しない', () => {
  const f = fixture(); const roles = f.game.players.map(p => p.role);
  f.send('v0', { type: 'remove', targetId: 'v2' }); f.confirmAll();
  assert.equal(f.game.phase, 'firstNight');
  assert.deepEqual(f.game.players.map(p => p.role), roles);
});

test('複数人狼の不一致も各自の確定で完了に数え、夜の延長後まで襲撃を待つ', () => {
  const f = fixture(8); toNight(f);
  f.send('w0', { type: 'select', targetId: 'v1' });
  f.send('w1', { type: 'select', targetId: 's' });
  f.send('s', { type: 'select', targetId: 'w0' });
  f.send('k', { type: 'select', targetId: 'm' });
  f.confirmAll();
  assert.equal(viewFor(f.game, 'v0').public.completedCount, 7);
  assert.equal(f.game.phase, 'night');
  assert.throws(() => f.send('w0', { type: 'select', targetId: 's' }));
  f.time(50_000); f.send('v0', { type: 'extend' });
  assert.equal(f.game.deadline, 120_000);
  f.time(60_000); f.tick(); assert.equal(f.game.phase, 'night');
  f.time(120_000); f.tick();
  assert.equal(f.game.phase, 'morning'); assert.equal(f.game.victimId, 'v1');
});

test('夜の犠牲者発生で人狼数と村側が同数になれば即終了する', () => {
  const f = fixture(); toNight(f);
  f.send('v0', { type: 'remove', targetId: 'v1' });
  f.send('w', { type: 'select', targetId: 's' });
  f.send('s', { type: 'select', targetId: 'w' }); f.confirmAll();
  f.time(60_000); f.tick();
  assert.equal(f.game.phase, 'finished'); assert.equal(f.game.winner, 'wolves');
  assert.equal(f.game.victimId, 's');
});
