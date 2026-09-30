import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame } from '../src/domain/game.ts';
import type { Command, Game } from '../src/domain/game.ts';

const composition = { villager: 2, wolf: 1, seer: 1, medium: 0, knight: 1, madman: 0, lover: 0, baker: 0, thief: 0 };

function night(consecutiveGuard: boolean) {
  let game = createGame({ id: 'guard', hostId: 'a', playerIds: ['a','b','c','d','e'], composition, consecutiveGuard }, 0, () => 0);
  game.phase = 'night'; game.phaseId = 10; game.confirmed = []; game.selections = {};
  let sequence = 0;
  const send = (actorId: string, action: Command['action']) => {
    game = applyCommand(game, { gameId: game.id, phaseId: game.phaseId, requestId: String(++sequence), actorId, action }, sequence, () => 0);
  };
  return { get game() { return game; }, set game(value: Game) { game = value; }, send };
}

test('連続護衛なしでは前夜と同じ相手を選べず、別の相手は選べる', () => {
  const f = night(false);
  const knight = f.game.players.find(player => player.role === 'knight')!;
  const targets = f.game.players.filter(player => player.id !== knight.id);
  f.game.lastGuardTargets[knight.id] = targets[0]!.id;
  assert.throws(() => f.send(knight.id, { type: 'select', targetId: targets[0]!.id }), /続けて護衛できません/);
  f.send(knight.id, { type: 'select', targetId: targets[1]!.id });
  assert.equal(f.game.selections[knight.id], targets[1]!.id);
});

test('連続護衛ありでは前夜と同じ相手を選べる', () => {
  const f = night(true);
  const knight = f.game.players.find(player => player.role === 'knight')!;
  const target = f.game.players.find(player => player.id !== knight.id)!;
  f.game.lastGuardTargets[knight.id] = target.id;
  f.send(knight.id, { type: 'select', targetId: target.id });
  assert.equal(f.game.selections[knight.id], target.id);
});
