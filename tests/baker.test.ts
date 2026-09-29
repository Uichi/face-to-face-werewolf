import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import { teamOf, validateComposition } from '../src/domain/rules.ts';
import type { Composition } from '../src/domain/rules.ts';

const composition: Composition = { villager: 1, wolf: 1, seer: 1, medium: 0, knight: 1, madman: 0, lover: 0, baker: 1 };

test('パン屋は村側で0〜1人、標準配役には含めない', () => {
  assert.equal(teamOf('baker'), 'village');
  validateComposition(5, composition);
  assert.throws(() => validateComposition(5, { ...composition, villager: 0, baker: 2 }));
});

test('生存しているパン屋がいる朝だけパンが届く', () => {
  let game = createGame({ id: 'baker', hostId: 'b', playerIds: ['b', 'w', 's', 'k', 'v'], composition }, 0, () => 0);
  game.phase = 'morning';
  assert.equal(viewFor(game, 'v').public.breadDelivered, true);
  game.players.find(player => player.role === 'baker')!.alive = false;
  assert.equal(viewFor(game, 'v').public.breadDelivered, false);
  game.phase = 'discussion';
  assert.equal(viewFor(game, 'v').public.breadDelivered, false);
});

test('パン屋は夜に対象選択せず確認だけ行う', () => {
  let game = createGame({ id: 'baker-night', hostId: 'b', playerIds: ['b', 'w', 's', 'k', 'v'], composition }, 0, () => 0);
  const baker = game.players.find(player => player.role === 'baker')!;
  game.phase = 'night'; game.phaseId = 5;
  assert.throws(() => applyCommand(game, { gameId: game.id, phaseId: 5, requestId: 'select', actorId: baker.id, action: { type: 'select', targetId: 'v' } }, 1, () => 0));
  game = applyCommand(game, { gameId: game.id, phaseId: 5, requestId: 'confirm', actorId: baker.id, action: { type: 'confirm' } }, 1, () => 0);
  assert.ok(game.confirmed.includes(baker.id));
});
