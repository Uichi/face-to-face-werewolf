// Server-only rules. Never serialize this module's full input state to clients.
export type Role = 'villager' | 'wolf' | 'seer' | 'medium' | 'knight';
export type Team = 'village' | 'wolves';
export type Composition = Record<Role, number>;
export type Player = { id: string; role: Role; alive: boolean };
export type Choice = { actorId: string; targetId: string };
// Production callers must supply a cryptographically secure uniform integer source.
export type RandomIndex = (exclusiveMax: number) => number;

const roles: Role[] = ['villager', 'wolf', 'seer', 'medium', 'knight'];
export const DEFAULT_COMPOSITIONS: Readonly<Record<number, Readonly<Composition>>> = Object.freeze({
  5: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 0, knight: 0 }),
  6: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 1, knight: 0 }),
  7: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 1, knight: 1 }),
  8: Object.freeze({ villager: 3, wolf: 2, seer: 1, medium: 1, knight: 1 }),
  9: Object.freeze({ villager: 4, wolf: 2, seer: 1, medium: 1, knight: 1 }),
  10: Object.freeze({ villager: 5, wolf: 2, seer: 1, medium: 1, knight: 1 }),
});

function requireRule(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pick<T>(values: readonly T[], random: RandomIndex): T {
  requireRule(values.length > 0, '候補がありません');
  const index = random(values.length);
  requireRule(Number.isInteger(index) && index >= 0 && index < values.length, '乱数が範囲外です');
  return values[index]!;
}

export function validateComposition(count: number, composition: Composition): void {
  requireRule(Number.isInteger(count) && count >= 5 && count <= 10, '参加人数は5〜10人です');
  requireRule(roles.every(role => Number.isInteger(composition[role]) && composition[role] >= 0), '配役は非負整数です');
  requireRule(roles.reduce((sum, role) => sum + composition[role], 0) === count, '配役合計が参加人数と一致しません');
  requireRule(composition.wolf >= 1 && composition.wolf < count - composition.wolf, '人狼は1人以上、村側より少なくしてください');
  requireRule(['seer', 'medium', 'knight'].every(role => composition[role as Role] <= 1), '能力職は各0〜1人です');
}

export function assignRoles(ids: readonly string[], composition: Composition, random: RandomIndex): Player[] {
  validateComposition(ids.length, composition);
  requireRule(new Set(ids).size === ids.length && ids.every(id => id.length > 0), '参加者IDが不正です');
  const pool = roles.flatMap(role => Array<Role>(composition[role]).fill(role));
  return ids.map(id => {
    const role = pick(pool, random);
    pool.splice(pool.indexOf(role), 1);
    return { id, role, alive: true };
  });
}

export function getWinner(players: readonly Player[]): Team | null {
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === 'wolf').length;
  if (wolves === 0) return 'village';
  return wolves >= alive.length - wolves ? 'wolves' : null;
}

export function initialWhite(players: readonly Player[], random: RandomIndex): { seerId: string; targetId: string; isWolf: false } | null {
  const seer = players.find(p => p.alive && p.role === 'seer');
  if (!seer) return null;
  const target = pick(players.filter(p => p.alive && p.role !== 'wolf' && p.id !== seer.id), random);
  return { seerId: seer.id, targetId: target.id, isWolf: false };
}

function completeChoices(actors: readonly Player[], choices: readonly Choice[]): void {
  requireRule(choices.length === actors.length && new Set(choices.map(c => c.actorId)).size === choices.length,
    '全員分の確定操作が必要です');
  requireRule(choices.every(c => actors.some(p => p.id === c.actorId)), '操作権限がありません');
}

export type VoteResult = {
  counts: Record<string, number>;
  executedId: string | null;
  runoffIds: string[];
};

export function resolveVote(players: readonly Player[], choices: readonly Choice[], runoffIds?: readonly string[]): VoteResult {
  const alive = players.filter(p => p.alive);
  requireRule(alive.length >= 2, '投票には2人以上必要です');
  const candidates = runoffIds ?? alive.map(p => p.id);
  requireRule(candidates.length >= 2 && new Set(candidates).size === candidates.length &&
    candidates.every(id => alive.some(p => p.id === id)), '候補者が不正です');
  completeChoices(alive, choices);
  requireRule(choices.every(c => c.actorId !== c.targetId && candidates.includes(c.targetId)), '投票先が不正です');
  const counts = Object.fromEntries(candidates.map(id => [id, 0]));
  for (const choice of choices) counts[choice.targetId]!++;
  const maximum = Math.max(...Object.values(counts));
  const leaders = candidates.filter(id => counts[id] === maximum);
  return { counts, executedId: leaders.length === 1 ? leaders[0]! : null, runoffIds: leaders.length > 1 && !runoffIds ? [...leaders] : [] };
}

export type NightActions = {
  attacks: readonly Choice[];
  divination: Choice | null;
  protection: Choice | null;
};

export function resolveNight(players: readonly Player[], actions: NightActions, random: RandomIndex) {
  requireRule(getWinner(players) === null, '終了した試合では夜を処理できません');
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === 'wolf');
  completeChoices(wolves, actions.attacks);
  requireRule(actions.attacks.every(c => alive.some(p => p.id === c.targetId && p.role !== 'wolf')), '襲撃先が不正です');

  function validateAbility(role: Role, action: Choice | null): Player | null {
    const actor = alive.find(p => p.role === role);
    if (!actor) {
      requireRule(action === null, '能力の使用者がいません');
      return null;
    }
    requireRule(action && action.actorId === actor.id && action.targetId !== actor.id, '能力の操作が不正です');
    const target = alive.find(p => p.id === action.targetId);
    requireRule(target, '能力の対象が生存していません');
    return target;
  }
  const divined = validateAbility('seer', actions.divination);
  const protectedPlayer = validateAbility('knight', actions.protection);
  const targets = [...new Set(actions.attacks.map(c => c.targetId))];
  const attackedId = targets.length === 1 ? targets[0]! : pick(targets, random);
  const victimId = protectedPlayer?.id === attackedId ? null : attackedId;
  const nextPlayers = players.map(p => p.id === victimId ? { ...p, alive: false } : { ...p });
  // The caller must filter this private result by recipient and life status.
  const divination = divined ? { seerId: actions.divination!.actorId, targetId: divined.id, isWolf: divined.role === 'wolf' } : null;
  return { players: nextPlayers, victimId, divination, winner: getWinner(nextPlayers) };
}

export function eliminate(players: readonly Player[], targetId: string, reason: 'execution' | 'disconnect') {
  const target = players.find(p => p.id === targetId && p.alive);
  requireRule(target, '脱落対象が生存していません');
  const nextPlayers = players.map(p => p.id === targetId ? { ...p, alive: false } : { ...p });
  const medium = nextPlayers.find(p => p.alive && p.role === 'medium');
  const mediumResult = reason === 'execution' && medium
    ? { mediumId: medium.id, targetId, isWolf: target.role === 'wolf' } : null;
  return { players: nextPlayers, mediumResult, winner: getWinner(nextPlayers) };
}
