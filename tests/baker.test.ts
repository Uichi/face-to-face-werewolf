import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, BREAD_TYPES, createGame, viewFor } from '../src/domain/game.ts';
import type { Command, Game } from '../src/domain/game.ts';
import { teamOf, validateComposition } from '../src/domain/rules.ts';
import type { Composition } from '../src/domain/rules.ts';

const composition: Composition = { villager: 1, wolf: 1, seer: 1, medium: 0, knight: 1, madman: 0, lover: 0, baker: 1 };

function fixture() {
  let game = createGame({ id: 'baker', hostId: 'b', playerIds: ['b', 'w', 's', 'k', 'v'], composition }, 0, () => 0);
  let sequence = 0;
  const send = (actorId: string, action: Command['action']) => {
    game = applyCommand(game, { gameId: game.id, phaseId: game.phaseId, requestId: String(++sequence), actorId, action }, sequence, () => 0);
  };
  return { get game() { return game; }, set game(value: Game) { game = value; }, send };
}

test('パン屋は村側で0〜1人、パンは6種類', () => {
  assert.equal(teamOf('baker'), 'village');
  assert.deepEqual(BREAD_TYPES, ['shokupan','croissant','melonpan','currypan','anpan','surprise']);
  validateComposition(5, composition);
  assert.throws(() => validateComposition(5, { ...composition, villager: 0, baker: 2 }));
});

test('初夜に選んだパンが最初の昼に届く', () => {
  const f = fixture();
  for (const player of f.game.players) f.send(player.id, { type: 'confirm' });
  const baker = f.game.players.find(player => player.role === 'baker')!;
  assert.throws(() => f.send(baker.id, { type: 'confirm' }));
  f.send(baker.id, { type: 'select', targetId: 'croissant' });
  for (const player of f.game.players) f.send(player.id, { type: 'confirm' });
  const view = viewFor(f.game, 'v');
  assert.equal(f.game.phase, 'discussion');
  assert.deepEqual(view.public.breadDelivery, { day: 0, breadType: 'croissant' });
  assert.equal(view.public.breadDelivered, true);
  assert.equal(view.public.publicLog.at(-1)?.kind, 'bread');
});

test('パン屋が襲撃された夜は選んだパンが届かない', () => {
  const f = fixture();
  const baker = f.game.players.find(player => player.role === 'baker')!;
  const wolf = f.game.players.find(player => player.role === 'wolf')!;
  const seer = f.game.players.find(player => player.role === 'seer')!;
  const knight = f.game.players.find(player => player.role === 'knight')!;
  f.game.phase = 'night'; f.game.phaseId = 5; f.game.confirmed = []; f.game.selections = {};
  f.send(baker.id, { type: 'select', targetId: 'anpan' });
  f.send(wolf.id, { type: 'select', targetId: baker.id, strength: 3 });
  f.send(seer.id, { type: 'select', targetId: wolf.id });
  f.send(knight.id, { type: 'select', targetId: seer.id });
  for (const player of f.game.players) f.send(player.id, { type: 'confirm' });
  const view = viewFor(f.game, wolf.id);
  assert.equal(view.public.victimId, baker.id);
  assert.equal(view.public.breadDelivered, false);
  assert.equal(view.public.breadDelivery, null);
});
