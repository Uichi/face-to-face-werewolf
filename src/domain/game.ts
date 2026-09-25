// Trusted server state. Clients must receive viewFor(), never Game directly.
import { assignRoles, eliminate, getWinner, initialWhite, resolveNight, resolveVote } from './rules.ts';
import type { Composition, Player, RandomIndex, Team, VoteResult } from './rules.ts';

export type Phase = 'roles' | 'firstNight' | 'discussion' | 'vote' | 'runoff' | 'execution' | 'night' | 'morning' | 'finished';
type Secret = { recipientId: string; targetId: string; isWolf: boolean; kind: 'initial' | 'seer' | 'medium'; day: number };
type Action =
  | { type: 'confirm' }
  | { type: 'select'; targetId: string }
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
  voteResult: VoteResult | null; victimId: string | null; winner: Team | null;
  secrets: Secret[]; removals: { playerId: string; day: number }[];
  receipts: Record<string, string>;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const alive = (game: Game) => game.players.filter(p => p.alive);
const allDone = (game: Game) => alive(game).every(p => game.confirmed.includes(p.id));
const hasAbility = (p: Player) => ['wolf', 'seer', 'knight'].includes(p.role);

function enter(game: Game, phase: Phase, now: number): void {
  game.phase = phase;
  game.phaseId++;
  game.selections = {};
  game.confirmed = [];
  game.runoffIds = [];
  game.deadline = phase === 'discussion' ? now + game.discussionMs
    : ['vote', 'runoff', 'night'].includes(phase) ? now + 60_000 : null;
}

function finishIfWon(game: Game, now: number): boolean {
  game.winner = getWinner(game.players);
  if (game.winner) enter(game, 'finished', now);
  return game.winner !== null;
}

export function createGame(input: {
  id: string; hostId: string; playerIds: string[]; composition: Composition; discussionMinutes?: number;
}, now: number, random: RandomIndex): Game {
  const minutes = input.discussionMinutes ?? 3;
  check(input.id.length > 0 && input.playerIds.includes(input.hostId), '試合・主催者が不正です');
  check(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10, '議論時間は1〜10分です');
  check(Number.isSafeInteger(now) && now >= 0, 'サーバー時刻が不正です');
  const players = assignRoles(input.playerIds, input.composition, random);
  return {
    id: input.id, hostId: input.hostId, players, phase: 'roles', phaseId: 1,
    day: 1, discussionMs: minutes * 60_000, deadline: null, lastTime: now,
    selections: {}, confirmed: [], runoffIds: [], voteResult: null, victimId: null,
    winner: null, secrets: [], removals: [], receipts: {},
  };
}

function settle(game: Game, now: number, random: RandomIndex): void {
  if (game.phase === 'roles' && allDone(game)) {
    const white = initialWhite(game.players, random);
    if (white) game.secrets.push({ recipientId: white.seerId, targetId: white.targetId, isWolf: false, kind: 'initial', day: 1 });
    enter(game, 'firstNight', now);
  } else if (game.phase === 'firstNight' && allDone(game)) {
    enter(game, 'discussion', now);
  } else if (game.phase === 'discussion' && now >= game.deadline!) {
    enter(game, 'vote', now);
  } else if (['vote', 'runoff'].includes(game.phase) && allDone(game)) {
    const votes = alive(game).map(p => ({ actorId: p.id, targetId: game.selections[p.id]! }));
    const result = resolveVote(game.players, votes, game.phase === 'runoff' ? game.runoffIds : undefined);
    game.voteResult = result;
    if (result.runoffIds.length) {
      enter(game, 'runoff', now);
      game.runoffIds = [...result.runoffIds];
    } else {
      if (result.executedId) {
        const death = eliminate(game.players, result.executedId, 'execution');
        game.players = death.players;
        if (death.mediumResult) game.secrets.push({
          recipientId: death.mediumResult.mediumId, targetId: result.executedId,
          isWolf: death.mediumResult.isWolf, kind: 'medium', day: game.day,
        });
      }
      if (!finishIfWon(game, now)) enter(game, 'execution', now);
    }
  } else if (game.phase === 'night' && allDone(game) && now >= game.deadline!) {
    const actionOf = (p: Player) => ({ actorId: p.id, targetId: game.selections[p.id]! });
    const living = alive(game);
    const seer = living.find(p => p.role === 'seer');
    const knight = living.find(p => p.role === 'knight');
    const result = resolveNight(game.players, {
      attacks: living.filter(p => p.role === 'wolf').map(actionOf),
      divination: seer ? actionOf(seer) : null,
      protection: knight ? actionOf(knight) : null,
    }, random);
    game.players = result.players;
    game.victimId = result.victimId;
    if (result.divination) game.secrets.push({
      recipientId: result.divination.seerId, targetId: result.divination.targetId,
      isWolf: result.divination.isWolf, kind: 'seer', day: game.day,
    });
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
        check(['vote', 'runoff', 'night'].includes(game.phase), '対象を選べる段階ではありません');
        check(!game.confirmed.includes(actor.id), '確定済みです');
        const target = game.players.find(p => p.id === action.targetId && p.alive);
        check(target && target.id !== actor.id, '対象が不正です');
        if (game.phase === 'runoff') check(game.runoffIds.includes(target.id), '決選候補ではありません');
        if (game.phase === 'night') {
          check(hasAbility(actor), '選択する能力がありません');
          if (actor.role === 'wolf') check(target.role !== 'wolf', '人狼は襲撃できません');
        }
        // Define own properties even for special identifiers such as __proto__.
        Object.defineProperty(game.selections, actor.id, { value: target.id, enumerable: true, writable: true, configurable: true });
        break;
      }
      case 'confirm': {
        check(['roles', 'firstNight', 'vote', 'runoff', 'night'].includes(game.phase), '確認する段階ではありません');
        if (['vote', 'runoff'].includes(game.phase) || (game.phase === 'night' && hasAbility(actor))) {
          check(Object.hasOwn(game.selections, actor.id), '先に対象を選んでください');
        }
        if (!game.confirmed.includes(actor.id)) game.confirmed.push(actor.id);
        break;
      }
      case 'next':
        check(game.phase === 'execution' || game.phase === 'morning', '結果画面ではありません');
        if (game.phase === 'execution') { game.victimId = null; enter(game, 'night', now); }
        else { game.voteResult = null; enter(game, 'discussion', now); }
        break;
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
        game.removals.push({ playerId: action.targetId, day: game.day });
        if (!finishIfWon(game, now)) {
          if (['vote', 'runoff', 'night'].includes(game.phase)) {
            const phase = game.phase === 'night' ? 'night' : 'vote';
            game.voteResult = null;
            enter(game, phase, now);
          } else {
            // Preserve existing confirmations/white information, invalidate in-flight commands.
            game.phaseId++;
            game.confirmed = game.confirmed.filter(id => alive(game).some(p => p.id === id));
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
    id: game.id, hostId: game.hostId, phase: game.phase, phaseId: game.phaseId, day: game.day,
    deadline: game.deadline, winner: game.winner,
    players: game.players.map(p => ({ id: p.id, alive: p.alive, ...(isFinished ? { role: p.role } : {}) })),
    composition: Object.fromEntries(['villager', 'wolf', 'seer', 'medium', 'knight'].map(role => [role, game.players.filter(p => p.role === role).length])),
    completedCount: game.confirmed.filter(id => alive(game).some(p => p.id === id)).length,
    requiredCount: alive(game).length,
    runoffIds: [...game.runoffIds], voteResult: structuredClone(game.voteResult), victimId: game.victimId,
    removals: structuredClone(game.removals),
  };
  if (!canSeePrivate) return { public: publicInfo, private: null, wolves: null };
  return {
    public: publicInfo,
    private: { role: viewer.role, confirmed: game.confirmed.includes(viewerId),
      selection: Object.hasOwn(game.selections, viewerId) ? game.selections[viewerId] : null,
      results: structuredClone(game.secrets.filter(s => s.recipientId === viewerId)),
    },
    wolves: viewer.role === 'wolf' ? {
      memberIds: game.players.filter(p => p.role === 'wolf').map(p => p.id),
      selections: game.phase === 'night' ? alive(game).filter(p => p.role === 'wolf').map(p => ({
        actorId: p.id, targetId: Object.hasOwn(game.selections, p.id) ? game.selections[p.id] : null,
      })) : [],
    } : null,
  };
}
