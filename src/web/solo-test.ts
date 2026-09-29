import { applyCommand, createGame, viewFor } from '../domain/game.ts';
import type { Command, Game, Phase } from '../domain/game.ts';
import { DEFAULT_COMPOSITIONS, NO_EXECUTION_ID } from '../domain/rules.ts';
import type { Composition, Role } from '../domain/rules.ts';
import { DEFAULT_VICTORY_POINTS } from '../domain/scoring.ts';
import type { GameResponse } from './game-api.ts';
import type { Room } from './types.ts';

export const SOLO_VIEWER = 'solo-0';
export type SoloSession = { game: Game; room: Room; now: number; sequence: number };

function compositionFor(role: Role, count: number): Composition {
  const composition = { ...DEFAULT_COMPOSITIONS[count]! };
  if (role === 'lover' && composition.lover === 0) {
    composition.villager -= 2; composition.lover = 2;
  } else if (composition[role] === 0) {
    composition.villager -= 1; composition[role] = 1;
  }
  return composition;
}

export function createSoloSession(role: Role = 'villager', count = 5): SoloSession {
  const composition = compositionFor(role, count);
  const ids = Array.from({ length: count }, (_, index) => `solo-${index}`);
  const game = createGame({ id: `solo-game-${Date.now()}`, hostId: SOLO_VIEWER, playerIds: ids, composition, discussionMinutes: 1 }, Date.now(), () => 0);
  const chosen = game.players.find(player => player.role === role)!;
  const mine = game.players.find(player => player.id === SOLO_VIEWER)!;
  [chosen.role, mine.role] = [mine.role, chosen.role];
  const room: Room = {
    id: 'solo-room', code: 'TESTMODE', hostId: SOLO_VIEWER, viewerId: SOLO_VIEWER, status: 'playing', revision: 1,
    loverRole: true, bakerRole: true, firstDayNoExecution: true, victoryPoints: { ...DEFAULT_VICTORY_POINTS }, discussionMinutes: 1, composition,
    customComposition: true, members: ids.map((id, index) => ({ id, nickname: index === 0 ? 'あなた' : `テスト${index}`, connected: true, points: 0 })),
  };
  return { game, room, now: game.lastTime, sequence: 0 };
}

export function soloResponse(session: SoloSession): GameResponse {
  const room = { ...session.room, status: session.game.phase === 'finished' ? 'finished' as const : 'playing' as const };
  return { ok: true, room, game: viewFor(session.game, SOLO_VIEWER), serverNow: session.now };
}

function run(session: SoloSession, actorId: string | null, action: Command['action']): SoloSession {
  const now = session.now + 1;
  const sequence = session.sequence + 1;
  const game = applyCommand(session.game, { gameId: session.game.id, phaseId: session.game.phaseId, requestId: `solo-${sequence}`, actorId, action }, now, () => 0);
  return { game, now, sequence, room: { ...session.room, revision: session.room.revision + 1, status: game.phase === 'finished' ? 'finished' : 'playing' } };
}

export function applySoloAction(session: SoloSession, action: string, payload: Record<string, unknown> = {}, actorId = SOLO_VIEWER): SoloSession {
  if (action === 'get') return session;
  if (action === 'rematch') return createSoloSession(session.game.players.find(player => player.id === SOLO_VIEWER)?.role ?? 'villager', session.game.players.length);
  if (action === 'select') return run(session, actorId, { type: 'select', targetId: String(payload.targetId) });
  if (action === 'remove') return run(session, actorId, { type: 'remove', targetId: String(payload.targetId) });
  if (['confirm', 'startVote', 'extend', 'next'].includes(action)) return run(session, actorId, { type: action } as Command['action']);
  throw new Error('この操作は試遊モードでは使えません。');
}

const needsSelection = (role: Role, phase: Phase) => ['vote', 'runoff'].includes(phase) || (phase === 'night' && ['wolf', 'seer', 'knight'].includes(role));
function targetFor(game: Game, actorId: string, preferredTargetId?: string): string {
  const actor = game.players.find(player => player.id === actorId)!;
  const candidates = game.players.filter(player => player.alive && player.id !== actorId
    && (game.phase !== 'runoff' || game.runoffIds.includes(player.id))
    && !(game.phase === 'night' && actor.role === 'wolf' && player.role === 'wolf'));
  if (preferredTargetId === NO_EXECUTION_ID && game.day === 1 && ['vote','runoff'].includes(game.phase)
    && (game.phase === 'vote' || game.runoffIds.includes(NO_EXECUTION_ID))) return NO_EXECUTION_ID;
  if (!candidates.length) throw new Error('選べる対象がいません。');
  if (preferredTargetId && candidates.some(player => player.id === preferredTargetId)) return preferredTargetId;
  if (['vote', 'runoff'].includes(game.phase)) return candidates.find(player => player.role === 'wolf')?.id ?? candidates[0]!.id;
  return candidates[0]!.id;
}

export function completeSoloPhase(session: SoloSession, includeViewer: boolean, preferredTargetId?: string): SoloSession {
  const startingPhase = session.game.phaseId;
  let next = session;
  if (next.game.phase === 'discussion') return includeViewer ? applySoloAction(next, 'startVote') : next;
  const actors = next.game.players.filter(player => player.alive && (includeViewer || player.id !== SOLO_VIEWER)).map(player => player.id);
  for (const actorId of actors) {
    if (next.game.phaseId !== startingPhase || next.game.phase === 'finished') break;
    const actor = next.game.players.find(player => player.id === actorId)!;
    if (next.game.confirmed.includes(actorId)) continue;
    if (needsSelection(actor.role, next.game.phase) && !Object.hasOwn(next.game.selections, actorId)) next = applySoloAction(next, 'select', { targetId: targetFor(next.game, actorId, preferredTargetId) }, actorId);
    next = applySoloAction(next, 'confirm', {}, actorId);
  }
  return next;
}

function prepareVote(session: SoloSession): SoloSession {
  const game = structuredClone(session.game);
  game.phase = 'vote'; game.phaseId += 1; game.day = 1; game.deadline = session.now + 60_000;
  game.selections = {}; game.confirmed = []; game.runoffIds = []; game.voteResult = null;
  return { ...session, game };
}

function prepareNight(session: SoloSession): SoloSession {
  const game = structuredClone(session.game);
  game.phase = 'night'; game.phaseId += 1; game.day = 1; game.deadline = session.now + 60_000;
  game.selections = {}; game.confirmed = []; game.runoffIds = []; game.voteResult = null; game.victimId = null;
  return { ...session, game };
}

export function createEndingScenario(winner: 'village' | 'wolves'): SoloSession {
  let session = prepareVote(createSoloSession('villager'));
  const wolf = session.game.players.find(player => player.role === 'wolf')!;
  if (winner === 'wolves') {
    const villagers = session.game.players.filter(player => player.role !== 'wolf');
    villagers.slice(0, 2).forEach(player => { player.alive = false; });
    const target = session.game.players.find(player => player.alive && player.role !== 'wolf' && player.id !== SOLO_VIEWER) ?? session.game.players.find(player => player.alive && player.role !== 'wolf')!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      session = applySoloAction(session, 'select', { targetId: actor.id === target.id ? wolf.id : target.id }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
  } else {
    for (const actor of session.game.players.filter(player => player.alive)) {
      session = applySoloAction(session, 'select', { targetId: actor.id === wolf.id ? SOLO_VIEWER : wolf.id }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
  }
  return session;
}

export type CheckScenario = 'lover-execution' | 'lover-attack' | 'guard-success' | 'guard-failure' | 'runoff' | 'no-execution' | 'no-execution-runoff' | 'baker-alive' | 'baker-dead' | 'seer-wolf';
export function createCheckScenario(kind: CheckScenario): SoloSession {
  if (kind === 'lover-execution') {
    let session = prepareVote(createSoloSession('lover'));
    const target = session.game.players.find(player => player.role === 'lover' && player.id !== SOLO_VIEWER)!;
    const wolf = session.game.players.find(player => player.role === 'wolf')!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      const fallback = actor.id === target.id ? wolf.id : target.id;
      session = applySoloAction(session, 'select', { targetId: fallback }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'lover-attack') {
    let session = prepareNight(createSoloSession('lover'));
    const target = session.game.players.find(player => player.role === 'lover' && player.id !== SOLO_VIEWER)!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      if (actor.role === 'wolf') session = applySoloAction(session, 'select', { targetId: target.id }, actor.id);
      else if (actor.role === 'seer') session = applySoloAction(session, 'select', { targetId: targetFor(session.game, actor.id) }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'guard-success') {
    let session = prepareNight(createSoloSession('knight'));
    const knight = session.game.players.find(player => player.role === 'knight')!;
    const target = session.game.players.find(player => player.alive && player.role !== 'wolf' && player.id !== knight.id)!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      if (actor.role === 'wolf' || actor.role === 'knight') session = applySoloAction(session, 'select', { targetId: target.id }, actor.id);
      else if (actor.role === 'seer') session = applySoloAction(session, 'select', { targetId: targetFor(session.game, actor.id) }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'guard-failure') {
    let session = prepareNight(createSoloSession('knight'));
    const knight = session.game.players.find(player => player.role === 'knight')!;
    const targets = session.game.players.filter(player => player.alive && player.role !== 'wolf' && player.id !== knight.id);
    const attacked = targets[0]!, guarded = targets[1]!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      if (actor.role === 'wolf') session = applySoloAction(session, 'select', { targetId: attacked.id }, actor.id);
      else if (actor.role === 'knight') session = applySoloAction(session, 'select', { targetId: guarded.id }, actor.id);
      else if (actor.role === 'seer') session = applySoloAction(session, 'select', { targetId: targetFor(session.game, actor.id) }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'no-execution') {
    let session = prepareVote(createSoloSession('villager'));
    for (const actor of session.game.players) {
      session = applySoloAction(session, 'select', { targetId: NO_EXECUTION_ID }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'no-execution-runoff') {
    let session = prepareVote(createSoloSession('villager'));
    const wolf = session.game.players.find(player => player.role === 'wolf')!;
    const others = session.game.players.filter(player => player.id !== wolf.id);
    const choices = new Map<string,string>([
      [wolf.id, NO_EXECUTION_ID], [others[0]!.id, NO_EXECUTION_ID],
      [others[1]!.id, wolf.id], [others[2]!.id, wolf.id], [others[3]!.id, others[0]!.id],
    ]);
    for (const actor of session.game.players) {
      session = applySoloAction(session, 'select', { targetId: choices.get(actor.id)! }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'baker-alive' || kind === 'baker-dead' || kind === 'seer-wolf') {
    let session = prepareNight(createSoloSession(kind === 'seer-wolf' ? 'seer' : 'baker'));
    const baker = session.game.players.find(player => player.role === 'baker');
    const wolf = session.game.players.find(player => player.role === 'wolf')!;
    const attacked = kind === 'baker-dead' ? baker! : session.game.players.find(player => player.alive && player.role === 'villager')!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      if (actor.role === 'wolf') session = applySoloAction(session, 'select', { targetId: attacked.id }, actor.id);
      else if (actor.role === 'seer') session = applySoloAction(session, 'select', { targetId: kind === 'seer-wolf' ? wolf.id : targetFor(session.game, actor.id) }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  let session = prepareVote(createSoloSession('villager'));
  const wolf = session.game.players.find(player => player.role === 'wolf')!;
  const villager = session.game.players.find(player => player.role === 'villager' && player.id !== SOLO_VIEWER)!;
  const others = session.game.players.filter(player => player.id !== wolf.id && player.id !== villager.id);
  const choices = new Map<string, string>([
    [wolf.id, villager.id], [villager.id, wolf.id], [others[0]!.id, wolf.id], [others[1]!.id, villager.id], [others[2]!.id, others[0]!.id],
  ]);
  for (const actor of session.game.players) {
    session = applySoloAction(session, 'select', { targetId: choices.get(actor.id)! }, actor.id);
    session = applySoloAction(session, 'confirm', {}, actor.id);
  }
  return session;
}
