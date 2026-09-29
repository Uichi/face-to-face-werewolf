// Server-only rules. Never serialize this module's full input state to clients.
export type Role = 'villager' | 'wolf' | 'seer' | 'medium' | 'knight' | 'madman' | 'lover' | 'baker' | 'thief';
export type Team = 'village' | 'wolves';
export type Composition = Record<Exclude<Role, 'thief'>, number> & { thief?: number };
export type Player = { id: string; role: Role; alive: boolean; initialRole?: Role; apparentRole?: Role; decoy?: boolean };
export type Choice = { actorId: string; targetId: string };
export type AttackChoice = Choice & { strength?: 1 | 2 | 3 };
// Production callers must supply a cryptographically secure uniform integer source.
export type RandomIndex = (exclusiveMax: number) => number;

export const roles: Role[] = ['villager', 'wolf', 'seer', 'medium', 'knight', 'madman', 'lover', 'baker', 'thief'];
export const DEFAULT_COMPOSITIONS: Readonly<Record<number, Readonly<Composition>>> = Object.freeze({
  5: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 0, knight: 0, madman: 0, lover: 0, baker: 0, thief: 0 }),
  6: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 1, knight: 0, madman: 0, lover: 0, baker: 0, thief: 0 }),
  7: Object.freeze({ villager: 3, wolf: 1, seer: 1, medium: 1, knight: 1, madman: 0, lover: 0, baker: 0, thief: 0 }),
  8: Object.freeze({ villager: 2, wolf: 2, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
  9: Object.freeze({ villager: 3, wolf: 2, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
  10: Object.freeze({ villager: 4, wolf: 2, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
  11: Object.freeze({ villager: 5, wolf: 2, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
  12: Object.freeze({ villager: 5, wolf: 3, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
  13: Object.freeze({ villager: 6, wolf: 3, seer: 1, medium: 1, knight: 1, madman: 1, lover: 0, baker: 0, thief: 0 }),
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
  requireRule(Number.isInteger(count) && count >= 5 && count <= 13, '参加人数は5〜13人です');
  requireRule(roles.every(role => Number.isInteger(composition[role] ?? 0) && (composition[role] ?? 0) >= 0), '配役は非負整数です');
  requireRule(roles.reduce((sum, role) => sum + (composition[role] ?? 0), 0) === count, '配役合計が参加人数と一致しません');
  requireRule(composition.wolf >= 1 && composition.wolf < count - composition.wolf, '人狼は1人以上、人間（狂人を含む）より少なくしてください');
  requireRule(composition.lover === 0 || composition.lover === 2, '恋人は0人か2人で設定してください');
  requireRule(['seer', 'medium', 'knight', 'madman', 'baker', 'thief'].every(role => (composition[role as Role] ?? 0) <= 1), '占い師・霊媒師・騎士・狂人・パン屋・怪盗は各0〜1人です');
}

export function assignRoles(ids: readonly string[], composition: Composition, random: RandomIndex): Player[] {
  validateComposition(ids.length, composition);
  requireRule(new Set(ids).size === ids.length && ids.every(id => id.length > 0), '参加者IDが不正です');
  const pool = roles.flatMap(role => Array<Role>(composition[role] ?? 0).fill(role));
  return ids.map(id => {
    const role = pick(pool, random);
    pool.splice(pool.indexOf(role), 1);
    return { id, role, initialRole: role, apparentRole: role, alive: true };
  });
}

export function teamOf(role: Role): Team { return role === 'wolf' || role === 'madman' ? 'wolves' : 'village'; }

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

export const NO_EXECUTION_ID = '__no_execution__';

export function resolveVote(players: readonly Player[], choices: readonly Choice[], runoffIds?: readonly string[], allowNoExecution = false): VoteResult {
  const alive = players.filter(p => p.alive);
  requireRule(alive.length >= 2, '投票には2人以上必要です');
  const candidates = runoffIds ?? [...alive.map(p => p.id), ...(allowNoExecution ? [NO_EXECUTION_ID] : [])];
  requireRule(candidates.length >= 2 && new Set(candidates).size === candidates.length &&
    candidates.every(id => id === NO_EXECUTION_ID ? allowNoExecution : alive.some(p => p.id === id)), '候補者が不正です');
  completeChoices(alive, choices);
  requireRule(choices.every(c => c.actorId !== c.targetId && candidates.includes(c.targetId)), '投票先が不正です');
  const counts = Object.fromEntries(candidates.map(id => [id, 0]));
  for (const choice of choices) counts[choice.targetId]!++;
  const maximum = Math.max(...Object.values(counts));
  const leaders = candidates.filter(id => counts[id] === maximum);
  const winner = leaders.length === 1 ? leaders[0]! : null;
  return { counts, executedId: winner === NO_EXECUTION_ID ? null : winner, runoffIds: leaders.length > 1 && !runoffIds ? [...leaders] : [] };
}

export type NightActions = {
  attacks: readonly AttackChoice[];
  divination: Choice | null;
  protection: Choice | null;
};

export function resolveNight(players: readonly Player[], actions: NightActions, random: RandomIndex) {
  requireRule(getWinner(players) === null, '終了した試合では夜を処理できません');
  const alive = players.filter(p => p.alive);
  const wolves = alive.filter(p => p.role === 'wolf');
  completeChoices(wolves, actions.attacks);
  requireRule(actions.attacks.every(c => alive.some(p => p.id === c.targetId) && c.actorId !== c.targetId && [1, 2, 3].includes(c.strength ?? 1)), '襲撃先が不正です');

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
  const totals = new Map<string, number>();
  for (const action of actions.attacks) totals.set(action.targetId, (totals.get(action.targetId) ?? 0) + (action.strength ?? 1));
  const maximum = Math.max(...totals.values());
  const targets = [...totals].filter(([, total]) => total === maximum).map(([id]) => id);
  const attackedId = targets.length === 1 ? targets[0]! : pick(targets, random);
  const victimId = protectedPlayer?.id === attackedId ? null : attackedId;
  const death = victimId ? eliminate(players, victimId, 'attack') : null;
  const nextPlayers = death?.players ?? players.map(p => ({ ...p }));
  // The caller must filter this private result by recipient and life status.
  const divination = divined ? { seerId: actions.divination!.actorId, targetId: divined.id, isWolf: divined.role === 'wolf' } : null;
  return { players: nextPlayers, victimId, followedIds: death?.followedIds ?? [], divination, winner: getWinner(nextPlayers) };
}

export function eliminate(players: readonly Player[], targetId: string, reason: 'execution' | 'disconnect' | 'attack') {
  const target = players.find(p => p.id === targetId && p.alive);
  requireRule(target, '脱落対象が生存していません');
  const followedIds = target.role === 'lover' ? players.filter(p => p.alive && p.role === 'lover' && p.id !== targetId).map(p => p.id) : [];
  const nextPlayers = players.map(p => p.id === targetId || followedIds.includes(p.id) ? { ...p, alive: false } : { ...p });
  const medium = nextPlayers.find(p => p.alive && p.role === 'medium');
  const mediumResult = reason === 'execution' && medium
    ? { mediumId: medium.id, targetId, isWolf: target.role === 'wolf' } : null;
  return { players: nextPlayers, followedIds, mediumResult, winner: getWinner(nextPlayers) };
}
