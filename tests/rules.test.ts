import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, DEFAULT_COMPOSITIONS, eliminate, getWinner, initialWhite, resolveNight, resolveVote, validateComposition } from '../src/domain/rules.ts';
import type { Player, Role } from '../src/domain/rules.ts';

const make = (roles: Role[]): Player[] => roles.map((role, index) => ({ id: String(index), role, alive: true }));
const five = () => make(['wolf', 'seer', 'villager', 'villager', 'villager']);
const choose = (targets: string[]) => targets.map((targetId, index) => ({ actorId: String(index), targetId }));

test('5〜10人の標準配役を検証し、過不足なく配布する', () => {
  for (let count = 5; count <= 10; count++) {
    const composition = DEFAULT_COMPOSITIONS[count]!;
    validateComposition(count, composition);
    const players = assignRoles(Array.from({ length: count }, (_, i) => String(i)), composition, max => max - 1);
    assert.equal(players.length, count);
    for (const [role, expected] of Object.entries(composition)) {
      assert.equal(players.filter(p => p.role === role).length, expected);
    }
  }
});

test('人数範囲・合計・人狼数・能力職上限・小数の不正を拒否する', () => {
  for (const [count, composition] of [
    [4, { villager: 2, wolf: 1, seer: 1, medium: 0, knight: 0 }],
    [5, { ...DEFAULT_COMPOSITIONS[5]!, villager: 4 }],
    [5, { villager: 4, wolf: 0, seer: 1, medium: 0, knight: 0 }],
    [6, { villager: 3, wolf: 3, seer: 0, medium: 0, knight: 0 }],
    [5, { villager: 2, wolf: 1, seer: 2, medium: 0, knight: 0 }],
    [5, { villager: 2.5, wolf: 1.5, seer: 1, medium: 0, knight: 0 }],
  ] as const) assert.throws(() => validateComposition(count, composition));
});

test('重複IDと不正な乱数を拒否する', () => {
  assert.throws(() => assignRoles(['a', 'a', 'b', 'c', 'd'], DEFAULT_COMPOSITIONS[5]!, () => 0));
  assert.throws(() => assignRoles(['a', 'b', 'c', 'd', 'e'], DEFAULT_COMPOSITIONS[5]!, max => max));
});

test('初夜の白通知は自分以外の村側のみ、占い師不在なら通知なし', () => {
  for (let index = 0; index < 3; index++) {
    const result = initialWhite(five(), () => index)!;
    assert.equal(result.seerId, '1');
    assert.ok(['2', '3', '4'].includes(result.targetId));
    assert.equal(result.isWolf, false);
  }
  assert.equal(initialWhite(make(['wolf', 'villager']), () => 0), null);
});

test('通常投票の最多票、同票の決選、決選同票で処刑なし', () => {
  assert.equal(resolveVote(five(), choose(['1', '0', '0', '0', '1'])).executedId, '0');
  const four = make(['wolf', 'villager', 'villager', 'villager']);
  const votes = choose(['1', '0', '0', '1']);
  assert.deepEqual(resolveVote(four, votes).runoffIds, ['0', '1']);
  const runoff = resolveVote(four, votes, ['0', '1']);
  assert.equal(runoff.executedId, null);
  assert.deepEqual(runoff.runoffIds, []);
  assert.equal(Object.hasOwn(runoff, 'choices'), false);
});

test('未操作、自己投票、二重投票、死者・決選候補外への投票を拒否する', () => {
  const players = five();
  assert.throws(() => resolveVote(players, choose(['1', '0'])));
  assert.throws(() => resolveVote(players, choose(['0', '0', '0', '0', '0'])));
  const votes = choose(['1', '0', '0', '0', '1']);
  assert.throws(() => resolveVote(players, [...votes.slice(0, 4), votes[0]!]));
  assert.throws(() => resolveVote(players, votes, ['1', '2']));
  players[1]!.alive = false;
  assert.throws(() => resolveVote(players, votes.filter(v => v.actorId !== '1')));
});

test('人狼の不一致は重複を除いた襲撃候補から選ぶ', () => {
  const players = make(['wolf', 'wolf', 'wolf', 'villager', 'villager', 'villager', 'villager']);
  const actions = { attacks: choose(['3', '3', '4']), divination: null, protection: null };
  for (let index = 0; index < 2; index++) {
    const result = resolveNight(players, actions, max => { assert.equal(max, 2); return index; });
    assert.equal(result.victimId, String(index + 3));
  }
});

test('襲撃された占い師も占いが成立し、入力は変更しない', () => {
  const players = five();
  const result = resolveNight(players, {
    attacks: [{ actorId: '0', targetId: '1' }],
    divination: { actorId: '1', targetId: '0' }, protection: null,
  }, () => 0);
  assert.equal(result.victimId, '1');
  assert.equal(result.divination?.isWolf, true);
  assert.equal(players[1]!.alive, true);
});

test('護衛成功・失敗と連続護衛、同じ相手の再占い', () => {
  const players = make(['wolf', 'seer', 'knight', 'villager', 'villager']);
  const actions = { attacks: [{ actorId: '0', targetId: '3' }], divination: { actorId: '1', targetId: '0' }, protection: { actorId: '2', targetId: '3' } };
  const first = resolveNight(players, actions, () => 0);
  assert.equal(first.victimId, null);
  assert.equal(resolveNight(first.players, actions, () => 0).victimId, null);
  assert.equal(resolveNight(players, { ...actions, protection: { actorId: '2', targetId: '4' } }, () => 0).victimId, '3');
});

test('未確定の能力・自己護衛・自己占い・人狼への襲撃・偽の実行者を拒否する', () => {
  const players = make(['wolf', 'seer', 'knight', 'villager', 'villager']);
  const valid = { attacks: [{ actorId: '0', targetId: '3' }], divination: { actorId: '1', targetId: '0' }, protection: { actorId: '2', targetId: '3' } };
  for (const action of [
    { ...valid, attacks: [] },
    { ...valid, divination: null },
    { ...valid, protection: { actorId: '2', targetId: '2' } },
    { ...valid, divination: { actorId: '1', targetId: '1' } },
    { ...valid, attacks: [{ actorId: '0', targetId: '0' }] },
    { ...valid, attacks: [{ actorId: '3', targetId: '4' }] },
  ]) assert.throws(() => resolveNight(players, action, () => 0));
});

test('処刑だけ霊媒通知し、途中脱落では通知せず即時勝敗判定する', () => {
  const players = make(['wolf', 'medium', 'villager', 'villager', 'villager']);
  const executed = eliminate(players, '0', 'execution');
  assert.deepEqual(executed.mediumResult, { mediumId: '1', targetId: '0', isWolf: true });
  assert.equal(executed.winner, 'village');
  assert.equal(eliminate(players, '0', 'disconnect').mediumResult, null);
  assert.equal(eliminate(players, '1', 'execution').mediumResult, null);
  assert.equal(eliminate(make(['wolf', 'villager', 'villager']), '2', 'disconnect').winner, 'wolves');
});

test('勝敗は生存者で判定し、終了後は夜を処理しない', () => {
  assert.equal(getWinner(five()), null);
  assert.equal(getWinner(make(['wolf', 'villager'])), 'wolves');
  assert.equal(getWinner(make(['villager', 'seer'])), 'village');
  assert.throws(() => resolveNight(make(['wolf', 'villager']), { attacks: [{ actorId: '0', targetId: '1' }], divination: null, protection: null }, () => 0));
});
