import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, FOOL_DISGUISES, NO_EXECUTION_ID, validateComposition } from '../src/domain/rules.ts';
import { randomCombinations } from '../src/domain/random-composition.ts';
import { viewFor } from '../src/domain/game.ts';
import { applySoloAction, completeSoloPhase, createFoolScenario, createRobbedScenario, SOLO_VIEWER } from '../src/web/solo-test.ts';

test('5〜13人でバカ0〜3人を抽選でき、4人は配役できない', () => {
  for (let count = 5; count <= 13; count++) {
    const options = randomCombinations(count, ['fool']);
    assert.deepEqual(options.map(comp => comp.fool), [0, 1, 2, 3]);
    assert.ok(options.every(comp => comp.villager >= 1));
  }
  const { room } = createFoolScenario('seer');
  assert.throws(() => validateComposition(10, { ...room.composition!, villager: room.composition!.villager - 1, fool: 4 }), /0〜3人/);
});

test('配られた対象役職からバカごとに抽選し、候補がなければ村人を表示する', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const base = { villager: 0, wolf: 1, fool: 2, seer: 1, medium: 0, knight: 1, madman: 0, lover: 0, baker: 0 };
  let calls = 0;
  const two = assignRoles(ids, base, () => Math.max(0, calls++ - ids.length));
  assert.deepEqual(two.filter(player => player.role === 'fool').map(player => player.apparentRole), ['seer', 'knight']);
  const one = assignRoles(ids, { ...base, seer: 0, villager: 1 }, () => 0);
  assert.deepEqual(one.filter(player => player.role === 'fool').map(player => player.apparentRole), ['knight', 'knight']);
  const none = assignRoles(ids, { ...base, seer: 0, knight: 0, villager: 2 }, () => 0);
  assert.deepEqual(none.filter(player => player.role === 'fool').map(player => player.apparentRole), ['villager', 'villager']);
});

test('三人の偽装は本人だけに表示され、六種類の操作は実際の能力を発動しない', () => {
  for (const disguise of FOOL_DISGUISES) {
    let session = createFoolScenario(disguise);
    const fools = session.game.players.filter(p => p.role === 'fool');
    const wolf = session.game.players.find(p => p.role === 'wolf')!;
    const victim = disguise === 'bodybuilder' ? fools[1]! : session.game.players.find(p => p.role === 'seer' && p.id !== SOLO_VIEWER)!;
    for (const fool of fools) {
      const view = viewFor(session.game, fool.id);
      assert.equal(view.private?.role, disguise);
      assert.ok(view.public.players.every(p => p.role === undefined && p.foolDisguise === undefined));
    }
    session = completeSoloPhase(session, true);
    assert.equal(session.game.phase, 'firstNight');
    for (const p of session.game.players) {
      if (p.apparentRole === 'baker') session = applySoloAction(session, 'select', { targetId: p.role === 'baker' ? 'anpan' : 'croissant' }, p.id);
      session = applySoloAction(session, 'confirm', {}, p.id);
    }
    assert.equal(session.game.breadDelivery?.breadType, disguise === 'baker' ? 'anpan' : undefined);
    session = applySoloAction(session, 'startVote');
    for (const p of session.game.players) {
      session = applySoloAction(session, 'select', { targetId: p.id === wolf.id ? fools[0]!.id : disguise === 'medium' ? wolf.id : NO_EXECUTION_ID }, p.id);
      session = applySoloAction(session, 'confirm', {}, p.id);
    }
    if (disguise === 'medium') {
      assert.ok(fools.every(p => viewFor(session.game, p.id).private?.results.some(r => r.kind === 'medium' && r.targetId === wolf.id && !r.isWolf)));
      continue;
    }
    session = applySoloAction(session, 'next');
    for (const p of session.game.players) {
      const shown = p.apparentRole;
      const targetId = p.role === 'wolf' ? victim.id
        : shown === 'seer' ? wolf.id
        : shown === 'knight' ? p.role === 'fool' ? victim.id : wolf.id
        : shown === 'doctor' ? p.role === 'fool' ? victim.id : '__no_injection__'
        : shown === 'baker' ? p.role === 'fool' ? 'croissant' : 'anpan' : null;
      if (targetId) session = applySoloAction(session, 'select', { targetId }, p.id);
      session = applySoloAction(session, 'confirm', {}, p.id);
    }
    assert.equal(session.game.victimId, victim.id);
    assert.equal(session.game.failedAttacks?.length ?? 0, 0);
    for (const p of fools) {
      assert.equal(session.game.scoring?.stats[p.id]?.contribution ?? 0, 0);
      if (disguise === 'seer') assert.ok(viewFor(session.game, p.id).private?.results.some(r => r.targetId === wolf.id && !r.isWolf));
      if (disguise === 'knight') assert.equal(session.game.lastGuardTargets[p.id], victim.id);
      if (disguise === 'doctor') assert.ok(session.game.injectionHistory?.some(entry => entry.actorId === p.id && entry.targetId === victim.id));
    }
    assert.equal(session.game.injectionCounts?.[victim.id], undefined);
  }
});

test('怪盗はバカの偽装を引き継ぎ、終了後だけ実際の役職を公開する', () => {
  const { game } = createRobbedScenario('fool');
  const thief = game.players.find(p => p.initialRole === 'thief')!;
  const victim = game.players.find(p => p.id === SOLO_VIEWER)!;
  assert.equal(victim.role, 'villager');
  assert.equal(thief.role, 'fool');
  assert.equal(viewFor(game, victim.id).private?.role, 'seer');
  assert.deepEqual(viewFor(game, thief.id).private?.thiefExchange, { targetId: victim.id, stolenRole: 'seer' });
  assert.equal(viewFor(game, thief.id).private?.actualRole, 'seer');
  const result = viewFor({ ...game, phase: 'finished', winner: 'village' }, thief.id);
  assert.equal(result.public.thiefReveal?.targetId, victim.id);
  assert.equal(result.public.players.find(p => p.id === thief.id)?.foolDisguise, 'seer');
  assert.equal(result.private, null);
});
