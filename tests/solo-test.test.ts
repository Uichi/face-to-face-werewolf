import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '../src/domain/rules.ts';
import { completeSoloPhase, createCheckScenario, createEndingScenario, createRobbedScenario, createSoloSession, SOLO_VIEWER, soloResponse } from '../src/web/solo-test.ts';

test('ひとり試遊では選んだ役職が本人に割り当てられる', () => {
  const roles: Role[] = ['villager', 'wolf', 'seer', 'medium', 'knight', 'madman', 'lover', 'baker'];
  for (const count of [5, 10, 13]) {
    for (const role of roles) {
      const session = createSoloSession(role, count);
      assert.equal(session.game.players.find(player => player.id === SOLO_VIEWER)?.role, role);
      assert.equal(session.game.players.length, count);
      assert.equal(session.room.members.length, count);
    }
  }
});

test('10人試遊を自動操作で役職確認から議論まで進められる', () => {
  let session = createSoloSession('villager', 10);
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'firstNight');
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'discussion');
  assert.equal(session.game.players.filter(player => player.role === 'wolf').length, 2);
  assert.equal(session.game.players.filter(player => player.role === 'madman').length, 1);
});

test('全員の自動操作で役職確認から議論まで進む', () => {
  let session = createSoloSession('seer');
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'firstNight');
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'discussion');
  assert.equal(soloResponse(session).game?.private?.role, 'seer');
});

test('怪盗に選んだ役職を奪われた初夜を一人で確認できる', () => {
  for (const role of ['seer', 'wolf', 'knight', 'lover'] as const) {
    const session = createRobbedScenario(role, 10);
    const response = soloResponse(session);
    const mine = session.game.players.find(player => player.id === SOLO_VIEWER)!;
    assert.equal(session.game.phase, 'firstNight');
    assert.equal(mine.role, 'villager');
    assert.equal(response.game!.private!.role, role);
    assert.equal(response.game!.private!.thiefExchange, null);
    assert.equal(session.game.players.filter(player => player.initialRole === 'thief').length, 1);
  }
});

test('村側勝利シナリオは投票と最後の脱落者を残す', () => {
  const session = createEndingScenario('village');
  const view = soloResponse(session).game!;
  assert.equal(view.public.phase, 'finished');
  assert.equal(view.public.winner, 'village');
  assert.equal(view.public.ending?.cause, 'execution');
  assert.ok(view.public.voteResult?.executedId);
  assert.ok(Object.values(view.public.voteResult?.counts ?? {}).some(count => count >= 3));
});

test('人狼側勝利シナリオも投票結果を表示できる', () => {
  const session = createEndingScenario('wolves');
  const view = soloResponse(session).game!;
  assert.equal(view.public.phase, 'finished');
  assert.equal(view.public.winner, 'wolves');
  assert.equal(view.public.ending?.cause, 'execution');
  assert.ok(view.public.voteResult?.executedId);
});

test('恋人の処刑と襲撃で相方の後追いを表示する', () => {
  for (const kind of ['lover-execution', 'lover-attack'] as const) {
    const view = soloResponse(createCheckScenario(kind)).game!;
    assert.equal(view.public.followedIds.length, 1);
    assert.equal(view.public.players.filter(player => !player.alive).length, 2);
    assert.equal(view.public.phase, kind === 'lover-execution' ? 'execution' : 'morning');
    assert.deepEqual(view.public.publicLog.at(-1)?.followedIds, view.public.followedIds);
  }
});

test('護衛成功と決選投票の確認場面を作れる', () => {
  const guarded = soloResponse(createCheckScenario('guard-success')).game!;
  assert.equal(guarded.public.phase, 'morning');
  assert.equal(guarded.public.victimId, null);
  assert.equal(guarded.public.players.every(player => player.alive), true);
  const runoff = soloResponse(createCheckScenario('runoff')).game!;
  assert.equal(runoff.public.phase, 'runoff');
  assert.equal(runoff.public.runoffIds.length, 2);
  assert.deepEqual([...Object.values(runoff.public.voteResult?.counts ?? {})].filter(count => count > 0).sort(), [1, 2, 2]);
});

test('処刑なし・護衛失敗・占い発見・パン屋の各場面を作れる', () => {
  const noExecution = soloResponse(createCheckScenario('no-execution')).game!;
  assert.equal(noExecution.public.phase, 'execution');
  assert.equal(noExecution.public.voteResult?.executedId, null);
  assert.equal(noExecution.public.voteResult?.counts.__no_execution__, 5);

  const noExecutionRunoff = soloResponse(createCheckScenario('no-execution-runoff')).game!;
  assert.equal(noExecutionRunoff.public.phase, 'runoff');
  assert.ok(noExecutionRunoff.public.runoffIds.includes('__no_execution__'));

  const failedGuard = soloResponse(createCheckScenario('guard-failure')).game!;
  assert.equal(failedGuard.public.phase, 'morning');
  assert.ok(failedGuard.public.victimId);

  const seer = soloResponse(createCheckScenario('seer-wolf')).game!;
  assert.ok(seer.private?.results.some(result => result.kind === 'seer' && result.isWolf));

  const bread = soloResponse(createCheckScenario('baker-alive')).game!;
  assert.equal(bread.public.breadDelivered, true);
  const noBread = soloResponse(createCheckScenario('baker-dead')).game!;
  assert.equal(noBread.public.breadDelivered, false);
  assert.ok(noBread.public.victimId);
});
