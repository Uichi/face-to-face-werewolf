// Trusted server state. Clients must receive viewFor(), never Game directly.
import { assignRoles, eliminate, getWinner, NO_EXECUTION_ID, resolveNight, resolveVote, roles, teamOf } from './rules.ts';
import type { Composition, Player, RandomIndex, Team, VoteResult } from './rules.ts';

import { DEFAULT_VICTORY_POINTS, validateVictoryPoints, recordPoint, calculateScores } from './scoring.ts';
import type { VictoryPoints, Scoring, Score } from './scoring.ts';

export type Elimination = { playerId: string; cause: 'execution' | 'attack' | 'disconnect'; day: number; followedIds?: string[] };
export type PublicLogEvent = { id: string; day: number; kind: 'execution' | 'noExecution' | 'attack' | 'noVictim'; playerId?: string; followedIds?: string[] };
export type Phase = 'roles' | 'firstNight' | 'discussion' | 'vote' | 'runoff' | 'execution' | 'night' | 'morning' | 'finished';
type Secret = { recipientId: string; targetId: string; isWolf: boolean; kind: 'initial' | 'seer' | 'medium'; day: number };
type Action =
  | { type: 'confirm' }
  | { type: 'select'; targetId: string; strength?: 1 | 2 | 3 }
  | { type: 'next' }
  | { type: 'startVote' }
  | { type: 'extend' }
  | { type: 'remove'; targetId: string }
  | { type: 'tick' };
export type Command = {
  gameId: string;
  phaseId: number;
  requestId: string;
  // Supplied by the authenticated server adapter, not by the request body.
  actorId: string | null;
  action: Action;
};
export type Game = {
  id: string; hostId: string; players: Player[]; phase: Phase; phaseId: number;
  day: number; discussionMs: number; deadline: number | null; lastTime: number;
  selections: Record<string, string>; confirmed: string[]; runoffIds: string[];
  attackStrengths: Record<string, 1 | 2 | 3>;
  voteResult: VoteResult | null; victimId: string | null; winner: Team | null;
  scoring?: Scoring; scores?: Score[];
  lastElimination?: Elimination | null;
  publicLog?: PublicLogEvent[];
  secrets: Secret[]; removals: { playerId: string; day: number }[];
  receipts: Record<string, string>;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const alive = (game: Game) => game.players.filter(p => p.alive);
const allDone = (game: Game) => alive(game).every(p => game.confirmed.includes(p.id));
const shownRole = (p: Player) => p.decoy ? (p.apparentRole ?? p.initialRole ?? p.role) : p.role;
const hasAbility = (p: Player) => ['wolf', 'seer', 'knight'].includes(shownRole(p));

function enter(game: Game, phase: Phase, now: number): void {
  game.phase = phase;
  game.phaseId++;
  game.selections = {};
  game.attackStrengths = {};
  game.confirmed = [];
  game.runoffIds = [];
  game.deadline = phase === 'discussion' ? now + game.discussionMs
    : ['vote', 'runoff', 'night'].includes(phase) ? now + 60_000 : null;
}

function finishIfWon(game: Game, now: number): boolean {
  game.winner = getWinner(game.players);
  if (game.winner) {
    if (game.scoring) game.scores = calculateScores(game.scoring, game.players, game.winner);
    enter(game, 'finished', now);
  }
  return game.winner !== null;
}

export function createGame(input: {
  id: string; hostId: string; playerIds: string[]; composition: Composition; discussionMinutes?: number; victoryPoints?: VictoryPoints;
}, now: number, random: RandomIndex): Game {
  const minutes = input.discussionMinutes ?? 3;
  check(input.id.length > 0 && input.playerIds.includes(input.hostId), '試合・主催者が不正です');
  check(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10, '議論時間は1〜10分です');
  check(Number.isSafeInteger(now) && now >= 0, 'サーバー時刻が不正です');
  const victoryPoints = { ...(input.victoryPoints ?? DEFAULT_VICTORY_POINTS) };
  validateVictoryPoints(victoryPoints);
  const players = assignRoles(input.playerIds, input.composition, random);
  return {
    id: input.id, hostId: input.hostId, players, phase: 'roles', phaseId: 1,
    day: 1, discussionMs: minutes * 60_000, deadline: null, lastTime: now,
    selections: {}, attackStrengths: {}, confirmed: [], runoffIds: [], voteResult: null, victimId: null,
    scoring: { victoryPoints, stats: {} }, winner: null, secrets: [], removals: [], publicLog: [], receipts: {},
  };
}

function settle(game: Game, now: number, random: RandomIndex): void {
  if (game.phase === 'roles' && allDone(game)) {
    const thief = game.players.find(p => p.alive && p.role === 'thief');
    if (thief) {
      const targetId = game.selections[thief.id];
      const target = game.players.find(p => p.alive && p.id === targetId && p.id !== thief.id);
      check(target, '怪盗の対象が不正です');
      const stolenRole = target.role;
      thief.role = stolenRole;
      thief.apparentRole = stolenRole;
      target.role = 'villager';
      // The target keeps seeing and operating the role they received at the start.
      target.apparentRole = target.initialRole ?? stolenRole;
      target.decoy = true;
    }
    enter(game, 'firstNight', now);
  } else if (game.phase === 'firstNight' && allDone(game)) {
    enter(game, 'discussion', now);
  } else if (game.phase === 'execution' && allDone(game)) {
    game.victimId = null; enter(game, 'night', now);
  } else if (game.phase === 'morning' && allDone(game)) {
    game.voteResult = null; enter(game, 'discussion', now);
  } else if (game.phase === 'discussion' && now >= game.deadline!) {
    enter(game, 'vote', now);
  } else if (['vote', 'runoff'].includes(game.phase) && allDone(game)) {
    const votes = alive(game).map(p => ({ actorId: p.id, targetId: game.selections[p.id]! }));
    const result = resolveVote(game.players, votes, game.phase === 'runoff' ? game.runoffIds : undefined, game.day === 1);
    game.voteResult = result;
    if (result.runoffIds.length) {
      enter(game, 'runoff', now);
      game.runoffIds = [...result.runoffIds];
    } else {
      if (result.executedId) {
        const target = game.players.find(p => p.id === result.executedId)!;
        for (const p of alive(game)) {
          if (game.selections[p.id] === target.id && (teamOf(p.role) === 'village' ? target.role === 'wolf' : teamOf(target.role) === 'village')) recordPoint(game.scoring, p.id, 'contribution');
        }
        const death = eliminate(game.players, result.executedId, 'execution');
        game.players = death.players;
        game.lastElimination = { playerId: result.executedId, cause: 'execution', day: game.day, ...(death.followedIds.length ? { followedIds: death.followedIds } : {}) };
        (game.publicLog??=[]).push({ id: `execution-${game.phaseId}`, day: game.day, kind: 'execution', playerId: result.executedId, ...(death.followedIds.length ? { followedIds: [...death.followedIds] } : {}) });
        if (death.mediumResult) game.secrets.push({
          recipientId: death.mediumResult.mediumId, targetId: result.executedId,
          isWolf: death.mediumResult.isWolf, kind: 'medium', day: game.day,
        });
        for (const p of alive(game).filter(p => shownRole(p) === 'medium' && p.role !== 'medium')) {
          game.secrets.push({ recipientId: p.id, targetId: result.executedId, isWolf: false, kind: 'medium', day: game.day });
        }
      } else (game.publicLog??=[]).push({ id: `no-execution-${game.phaseId}`, day: game.day, kind: 'noExecution' });
      if (!finishIfWon(game, now)) enter(game, 'execution', now);
    }
  } else if (game.phase === 'night' && allDone(game)) {
    const actionOf = (p: Player) => ({ actorId: p.id, targetId: game.selections[p.id]! });
    const living = alive(game);
    const seer = living.find(p => p.role === 'seer');
    const knight = living.find(p => p.role === 'knight');
    const result = resolveNight(game.players, {
      attacks: living.filter(p => p.role === 'wolf').map(p => ({ ...actionOf(p), strength: game.attackStrengths[p.id]! })),
      divination: seer ? actionOf(seer) : null,
      protection: knight ? actionOf(knight) : null,
    }, random);
    if (result.divination?.isWolf) recordPoint(game.scoring, result.divination.seerId, 'contribution', result.divination.targetId);
    if (knight && result.victimId === null) recordPoint(game.scoring, knight.id, 'contribution');
    game.players = result.players;
    for (const p of alive(game)) recordPoint(game.scoring, p.id, 'survival');
    game.victimId = result.victimId;
    if (result.victimId) {
      game.lastElimination = { playerId: result.victimId, cause: 'attack', day: game.day, ...(result.followedIds.length ? { followedIds: result.followedIds } : {}) };
      (game.publicLog??=[]).push({ id: `attack-${game.phaseId}`, day: game.day, kind: 'attack', playerId: result.victimId, ...(result.followedIds.length ? { followedIds: [...result.followedIds] } : {}) });
    } else (game.publicLog??=[]).push({ id: `no-victim-${game.phaseId}`, day: game.day, kind: 'noVictim' });
    if (result.divination) game.secrets.push({
      recipientId: result.divination.seerId, targetId: result.divination.targetId,
      isWolf: result.divination.isWolf, kind: 'seer', day: game.day,
    });
    for (const p of living.filter(p => shownRole(p) === 'seer' && p.role !== 'seer')) {
      game.secrets.push({ recipientId: p.id, targetId: game.selections[p.id]!, isWolf: false, kind: 'seer', day: game.day });
    }
    game.day++;
    if (!finishIfWon(game, now)) enter(game, 'morning', now);
  }
}

// Persist the returned state with an atomic compare-and-swap/transaction in the server adapter.
// now and random are trusted server dependencies. Concurrent requests must never overwrite one another.
export function applyCommand(previous: Game, command: Command, now: number, random: RandomIndex): Game {
  check(command.gameId === previous.id, '別の試合の操作です');
  check(command.requestId.length > 0, '操作IDが必要です');
  check(Number.isSafeInteger(now) && now >= previous.lastTime, 'サーバー時刻が不正です');
  const receiptKey = JSON.stringify([command.actorId, command.requestId]);
  const fingerprint = JSON.stringify([command.phaseId, command.action]);
  if (Object.hasOwn(previous.receipts, receiptKey)) {
    check(previous.receipts[receiptKey] === fingerprint, '同じ操作IDの内容が異なります');
    return structuredClone(previous);
  }
  check(command.phaseId === previous.phaseId, '古い段階の操作です');
  check(previous.phase !== 'finished', '試合は終了しています');
  const game = structuredClone(previous);
  game.attackStrengths ??= {};
  const { action, actorId } = command;
  const actor = game.players.find(p => p.id === actorId);
  if (action.type === 'tick') {
    check(actorId === null, '時計の処理はサーバー専用です');
  } else {
    check(actor, '参加者ではありません');
    if (['next', 'startVote', 'extend', 'remove'].includes(action.type)) {
      check(actor.id === game.hostId, '主催者のみ操作できます');
    } else {
      check(actor.alive, '脱落者は操作できません');
    }
    switch (action.type) {
      case 'select': {
        check(['roles', 'vote', 'runoff', 'night'].includes(game.phase), '対象を選べる段階ではありません');
        check(!game.confirmed.includes(actor.id), '確定済みです');
        const noExecution = action.targetId === NO_EXECUTION_ID && game.day === 1 && !['roles', 'night'].includes(game.phase);
        const target = game.players.find(p => p.id === action.targetId && p.alive);
        check(noExecution || (target && target.id !== actor.id), '対象が不正です');
        if (game.phase === 'roles') check(shownRole(actor) === 'thief' && target, '怪盗だけが交換相手を選べます');
        if (game.phase === 'runoff') check(game.runoffIds.includes(action.targetId), '決選候補ではありません');
        if (game.phase === 'night') {
          check(target, '対象が不正です');
          check(hasAbility(actor), '選択する能力がありません');
          if (shownRole(actor) === 'wolf') {
            check(action.strength === undefined || [1, 2, 3].includes(action.strength), '襲撃の希望度を選んでください');
            game.attackStrengths[actor.id] = action.strength ?? 2;
          }
        }
        // Define own properties even for special identifiers such as __proto__.
        Object.defineProperty(game.selections, actor.id, { value: action.targetId, enumerable: true, writable: true, configurable: true });
        break;
      }
      case 'confirm': {
        check(['roles', 'firstNight', 'vote', 'runoff', 'night', 'execution', 'morning'].includes(game.phase), '確認する段階ではありません');
        if ((game.phase === 'roles' && shownRole(actor) === 'thief') || ['vote', 'runoff'].includes(game.phase) || (game.phase === 'night' && hasAbility(actor))) {
          check(Object.hasOwn(game.selections, actor.id), '先に対象を選んでください');
        }
        if (!game.confirmed.includes(actor.id)) game.confirmed.push(actor.id);
        break;
      }
      case 'next':
        throw new Error('結果は生存者全員の確認で進みます');
      case 'startVote':
        check(game.phase === 'discussion', '議論中ではありません');
        game.voteResult = null;
        enter(game, 'vote', now);
        break;
      case 'extend':
        check(['discussion', 'vote', 'runoff', 'night'].includes(game.phase), '延長できる段階ではありません');
        game.deadline = Math.max(now, game.deadline!) + 60_000;
        break;
      case 'remove': {
        const death = eliminate(game.players, action.targetId, 'disconnect');
        game.players = death.players;
        game.lastElimination = { playerId: action.targetId, cause: 'disconnect', day: game.day, ...(death.followedIds.length ? { followedIds: death.followedIds } : {}) };
        game.removals.push(...[action.targetId, ...death.followedIds].map(playerId => ({ playerId, day: game.day })));
        if (!finishIfWon(game, now)) {
          if (['vote', 'runoff', 'night'].includes(game.phase)) {
            const phase = game.phase === 'night' ? 'night' : 'vote';
            game.voteResult = null;
            enter(game, phase, now);
          } else {
            // Preserve existing confirmations/white information, invalidate in-flight commands.
            game.phaseId++;
            game.confirmed = game.confirmed.filter(id => alive(game).some(p => p.id === id));
            if (game.phase === 'roles' && Object.values(game.selections).includes(action.targetId)) {
              for (const [id, selected] of Object.entries(game.selections)) if (selected === action.targetId) { delete game.selections[id]; game.confirmed = game.confirmed.filter(done => done !== id); }
            }
          }
        }
        break;
      }
    }
  }
  game.lastTime = now;
  settle(game, now, random);
  game.receipts[receiptKey] = fingerprint;
  return game;
}

export function viewFor(game: Game, viewerId: string) {
  const viewer = game.players.find(p => p.id === viewerId);
  check(viewer, '参加者ではありません');
  const isFinished = game.phase === 'finished';
  const canSeePrivate = viewer.alive && !isFinished;
  const publicInfo = {
    resultConfirmation: true,
    scores: isFinished ? structuredClone(game.scores ?? null) : null,
    id: game.id, hostId: game.hostId, phase: game.phase, phaseId: game.phaseId, day: game.day,
    deadline: game.deadline, winner: game.winner,
    players: game.players.map(p => ({ id: p.id, alive: p.alive, ...(isFinished ? { role: p.role, initialRole: p.initialRole ?? p.role } : {}) })),
    composition: Object.fromEntries(roles.map(role => [role, game.players.filter(p => (p.initialRole ?? p.role) === role).length])),
    breadDelivered: game.phase === 'morning' && game.players.some(p => p.alive && p.role === 'baker'),
    completedCount: game.confirmed.filter(id => alive(game).some(p => p.id === id)).length,
    requiredCount: alive(game).length,
    runoffIds: [...game.runoffIds], voteResult: structuredClone(game.voteResult), victimId: game.victimId,
    removals: structuredClone(game.removals),
    publicLog: structuredClone(game.publicLog ?? []),
    followedIds: (game.phase === 'execution' && game.voteResult?.executedId === game.lastElimination?.playerId && game.lastElimination?.cause === 'execution') || (game.phase === 'morning' && game.victimId && game.lastElimination?.cause === 'attack') ? [...(game.lastElimination?.followedIds ?? [])] : [],
    ending: isFinished ? structuredClone(game.lastElimination ?? null) : null,
  };
  if (!canSeePrivate) return { public: publicInfo, private: null, wolves: null };
  return {
    public: publicInfo,
    private: { role: shownRole(viewer), actualRole: game.phase === 'firstNight' && viewer.initialRole === 'thief' ? viewer.role : undefined,
      thiefExchange: viewer.initialRole === 'thief' && viewer.role !== 'thief' ? {
        targetId: game.players.find(p => p.decoy)?.id ?? null, stolenRole: viewer.role,
      } : null,
      loverId: shownRole(viewer) === 'lover' ? (viewer.initialRole === 'lover'
        ? game.players.find(p => p.initialRole === 'lover' && p.id !== viewerId)?.id ?? null
        : game.players.find(p => p.role === 'lover' && p.id !== viewerId)?.id ?? null) : null, confirmed: game.confirmed.includes(viewerId),
      selection: Object.hasOwn(game.selections, viewerId) ? game.selections[viewerId] : null,
      attackStrength: game.attackStrengths[viewerId] ?? null,
      results: structuredClone(game.secrets.filter(s => s.recipientId === viewerId)),
    },
    wolves: shownRole(viewer) === 'wolf' ? {
      memberIds: game.players.filter(p => viewer.initialRole === 'wolf' ? p.initialRole === 'wolf' : p.role === 'wolf').map(p => p.id),
      selections: [] as { actorId: string; targetId: string | null }[],
    } : null,
  };
}
