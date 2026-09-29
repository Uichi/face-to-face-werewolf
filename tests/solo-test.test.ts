import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '../src/domain/rules.ts';
import { completeSoloPhase, createEndingScenario, createSoloSession, SOLO_VIEWER, soloResponse } from '../src/web/solo-test.ts';

test('ひとり試遊では選んだ役職が本人に割り当てられる', () => {
  const roles: Role[] = ['villager', 'wolf', 'seer', 'medium', 'knight', 'madman', 'lover'];
  for (const role of roles) {
    const session = createSoloSession(role);
    assert.equal(session.game.players.find(player => player.id === SOLO_VIEWER)?.role, role);
    assert.equal(session.game.players.length, 5);
  }
});

test('全員の自動操作で役職確認から議論まで進む', () => {
  let session = createSoloSession('seer');
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'firstNight');
  session = completeSoloPhase(session, true);
  assert.equal(session.game.phase, 'discussion');
  assert.equal(soloResponse(session).game?.private?.role, 'seer');
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
