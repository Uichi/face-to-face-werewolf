import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Command, Game } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS, resolveNight } from '../src/domain/rules.ts';

function send(game: Game, actorId: string, action: Command['action'], sequence: number) {
  return applyCommand(game, { gameId: game.id, phaseId: game.phaseId, requestId: `r-${sequence}`, actorId, action }, sequence, () => 0);
}

test('怪盗は確認時に選んだ役職を奪い、相手には元の役職を表示し続ける', () => {
  const composition = { ...DEFAULT_COMPOSITIONS[5]!, villager: 2, thief: 1 };
  let game = createGame({ id: 'thief-game', hostId: 'p0', playerIds: ['p0','p1','p2','p3','p4'], composition }, 0, () => 0);
  const thief = game.players.find(player => player.role === 'thief')!;
  const seer = game.players.find(player => player.role === 'seer')!;
  game = send(game, thief.id, { type: 'select', targetId: seer.id }, 1);
  let sequence = 2;
  for (const player of game.players) game = send(game, player.id, { type: 'confirm' }, sequence++);
  assert.equal(game.phase, 'firstNight');
  assert.equal(game.players.find(player => player.id === thief.id)!.role, 'seer');
  assert.equal(game.players.find(player => player.id === seer.id)!.role, 'villager');
  assert.equal(viewFor(game, thief.id).private!.role, 'seer');
  assert.equal(viewFor(game, seer.id).private!.role, 'seer');
  assert.deepEqual(viewFor(game, thief.id).private!.results, []);
  assert.equal(viewFor(game, 'p0').public.players.some(player => 'role' in player), false);
});

test('人狼は仲間も襲撃でき、希望度合計が最大の対象を襲撃する', () => {
  const players = [
    { id: 'w1', role: 'wolf' as const, alive: true }, { id: 'w2', role: 'wolf' as const, alive: true },
    { id: 'v1', role: 'villager' as const, alive: true }, { id: 'v2', role: 'villager' as const, alive: true },
    { id: 'v3', role: 'villager' as const, alive: true },
  ];
  const result = resolveNight(players, {
    attacks: [{ actorId: 'w1', targetId: 'w2', strength: 3 }, { actorId: 'w2', targetId: 'v1', strength: 2 }],
    divination: null, protection: null,
  }, () => 0);
  assert.equal(result.victimId, 'w2');
  assert.equal(result.players.find(player => player.id === 'w2')!.alive, false);
});
