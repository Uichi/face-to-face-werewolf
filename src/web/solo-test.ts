import { randomComposition, RANDOM_ROLES } from '../domain/random-composition.ts';
import { applyCommand, BREAD_TYPES, createGame, viewFor } from '../domain/game.ts';
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
  } else if ((composition[role] ?? 0) === 0) {
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
  chosen.initialRole = chosen.apparentRole = chosen.role;
  mine.initialRole = mine.apparentRole = mine.role;
  const room: Room = {
    id: 'solo-room', code: 'TESTMODE', hostId: SOLO_VIEWER, viewerId: SOLO_VIEWER, status: 'playing', revision: 1,
    loverRole: true, bakerRole: true, breadChoices: true, thiefRole: true, hunterRole: true, doctorRole: true, firstDayNoExecution: true, wolfboundEnabled: true, victoryPoints: { ...DEFAULT_VICTORY_POINTS }, discussionMinutes: 1, composition,
    customComposition: true, members: ids.map((id, index) => ({ id, nickname: index === 0 ? 'あなた' : `テスト${index}`, connected: true, points: 0 })),
  };
  return { game, room, now: game.lastTime, sequence: 0 };
}

export function createRandomSoloSession(count=10):SoloSession {
  const random = (max:number)=> { const range=4294967296-(4294967296%max);let value:number;do {value=crypto.getRandomValues(new Uint32Array(1))[0]!;}while(value>=range);return value%max; };
  const composition=randomComposition(count,RANDOM_ROLES,random);
  const session=createSoloSession('villager',count);
  session.game=createGame({id:session.game.id,hostId:SOLO_VIEWER,playerIds:session.game.players.map(p=>p.id),composition,discussionMinutes:1,randomCandidates:RANDOM_ROLES},session.now,random);
  session.room={...session.room,composition:null,compositionMode:'random',randomComposition:true,randomCandidates:[...RANDOM_ROLES],fixedWolves:composition.wolf,customComposition:false};
  return session;
}

export function createRobbedScenario(role: Exclude<Role, 'thief'>, count = 10): SoloSession {
  let session = createSoloSession(role, count);
  const mine = session.game.players.find(player => player.id === SOLO_VIEWER)!;
  const thief = session.game.players.find(player => player.id !== SOLO_VIEWER && player.role === 'villager')
    ?? session.game.players.find(player => player.id !== SOLO_VIEWER && player.role !== 'wolf' && player.role !== 'lover')!;
  const previousRole = thief.role;
  thief.role = thief.initialRole = thief.apparentRole = 'thief';
  session.room.composition = {
    ...session.room.composition!,
    [previousRole]: (session.room.composition![previousRole] ?? 0) - 1,
    thief: 1,
  };
  session = applySoloAction(session, 'select', { targetId: mine.id }, thief.id);
  for (const player of session.game.players) session = applySoloAction(session, 'confirm', {}, player.id);
  return session;
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
  if (action === 'select') {
    const actor = session.game.players.find(player => player.id === actorId);
    const wolfAtNight = session.game.phase === 'night' && (actor?.apparentRole ?? actor?.role) === 'wolf';
    return run(session, actorId, { type: 'select', targetId: String(payload.targetId), ...(wolfAtNight ? { strength: Number(payload.strength ?? 2) as 1|2|3 } : {}) });
  }
  if (action === 'remove') return run(session, actorId, { type: 'remove', targetId: String(payload.targetId) });
  if (['confirm', 'startVote', 'extend', 'next', 'cancelShot'].includes(action)) return run(session, actorId, { type: action } as Command['action']);
  throw new Error('この操作は試遊モードでは使えません。');
}

const needsSelection = (role: Role, phase: Phase) => ['vote', 'runoff'].includes(phase) || (phase === 'roles' && role === 'thief') || (['firstNight','night'].includes(phase) && role === 'baker') || (phase === 'night' && ['wolf', 'seer', 'knight', 'doctor'].includes(role));
function targetFor(game: Game, actorId: string, preferredTargetId?: string): string {
  const actor = game.players.find(player => player.id === actorId)!;
  if ((actor.apparentRole ?? actor.role) === 'baker' && ['firstNight','night'].includes(game.phase)) return BREAD_TYPES[Math.floor(Math.random() * BREAD_TYPES.length)]!;
  const candidates = game.players.filter(player => player.alive && (player.id !== actorId || game.phase==='night'&&(game.players.find(p=>p.id===actorId)?.apparentRole??game.players.find(p=>p.id===actorId)?.role)==='doctor')
    && (game.phase !== 'runoff' || game.runoffIds.includes(player.id))
  );
  if (preferredTargetId === NO_EXECUTION_ID && game.day === 1 && ['vote','runoff'].includes(game.phase)
    && (game.phase === 'vote' || game.runoffIds.includes(NO_EXECUTION_ID))) return NO_EXECUTION_ID;
  if (!candidates.length) throw new Error('選べる対象がいません。');
  if (preferredTargetId && candidates.some(player => player.id === preferredTargetId)) return preferredTargetId;
  return candidates[Math.floor(Math.random() * candidates.length)]!.id;
}

export function completeSoloPhase(session: SoloSession, includeViewer: boolean, preferredTargetId?: string): SoloSession {
  const startingPhase = session.game.phaseId;
  let next = session;
  if (next.game.phase === 'discussion') return includeViewer ? applySoloAction(next, 'startVote') : next;
  if (['execution', 'morning'].includes(next.game.phase)) return includeViewer ? applySoloAction(next, 'next') : next;
  if (next.game.phase === 'hunter') {
    const actorId=next.game.hunterPending!.actorId;
    if (!includeViewer && actorId===SOLO_VIEWER) return next;
    if (!next.game.selections[actorId]) next=applySoloAction(next,'select',{targetId:targetFor(next.game,actorId,preferredTargetId)},actorId);
    return applySoloAction(next,'confirm',{},actorId);
  }
  const actors = next.game.players.filter(player => player.alive && (includeViewer || player.id !== SOLO_VIEWER)).map(player => player.id);
  for (const actorId of actors) {
    if (next.game.phaseId !== startingPhase || next.game.phase === 'finished') break;
    const actor = next.game.players.find(player => player.id === actorId)!;
    if (next.game.confirmed.includes(actorId)) continue;
    if (needsSelection(actor.apparentRole ?? actor.role, next.game.phase) && !Object.hasOwn(next.game.selections, actorId)) next = applySoloAction(next, 'select', { targetId: targetFor(next.game, actorId, preferredTargetId), ...((actor.apparentRole ?? actor.role) === 'wolf' && next.game.phase === 'night' ? { strength: (Math.floor(Math.random()*3)+1) as 1|2|3 } : {}) }, actorId);
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

export type CheckScenario = 'lover-execution' | 'lover-attack' | 'guard-success' | 'guard-failure' | 'runoff' | 'no-execution' | 'no-execution-runoff' | 'baker-alive' | 'baker-dead' | 'seer-wolf' | 'seer-wolfbound' | 'medium-wolfbound' | 'thief-wolfbound' | 'hunter-execution' | 'hunter-attack' | 'hunter-lover' | 'hunter-wolf' | 'thief-hunter' | 'doctor-protect' | 'doctor-delayed' | 'doctor-double' | 'doctor-hunter' | 'thief-doctor';
export function createCheckScenario(kind: CheckScenario): SoloSession {
  if(kind==='thief-doctor') {
    let session=createSoloSession('thief',10);
    const target=session.game.players.find(p=>p.role==='villager'&&p.id!==SOLO_VIEWER)!;target.role=target.initialRole=target.apparentRole='doctor';
    session=applySoloAction(session,'select',{targetId:target.id});return completeSoloPhase(session,true);
  }
  if(kind.startsWith('doctor-')) {
    let session=createSoloSession('doctor',10);const g=session.game;
    const doctor=g.players.find(p=>p.id===SOLO_VIEWER)!;doctor.role=doctor.initialRole=doctor.apparentRole='doctor';
    const target=g.players.find(p=>p.id!==SOLO_VIEWER&&p.role==='villager')!;
    if(kind==='doctor-hunter')target.role=target.initialRole=target.apparentRole='hunter';
    let other=g.players.find(p=>p.role==='villager'&&p.id!==target.id);
    if(kind==='doctor-double'&&other)other.role=other.initialRole=other.apparentRole='doctor';
    if(kind==='doctor-delayed'||kind==='doctor-hunter') {g.injectionCounts={[target.id]:1};g.injectionHistory=[{actorId:SOLO_VIEWER,targetId:target.id,day:1}];}
    g.phase='night';g.phaseId++;g.day=4;g.deadline=session.now+60000;g.selections={};g.confirmed=[];
    const guardTarget=g.players.find(p=>p.role==='villager'&&p.id!==target.id)!.id;
    for(const p of [...g.players]) {
      if(['wolf','seer','knight','doctor','baker'].includes(p.role))session=applySoloAction(session,'select',{targetId:p.role==='baker'?'croissant':p.role==='knight'?guardTarget:target.id,strength:2},p.id);
      session=applySoloAction(session,'confirm',{},p.id);
    }
    return session;
  }
  if (kind === 'thief-hunter') {
    let session=createSoloSession('thief',10);
    const target=session.game.players.find(p=>p.role==='villager'&&p.id!==SOLO_VIEWER)!;
    target.role=target.initialRole=target.apparentRole='hunter';
    session.room.composition!.villager--;session.room.composition!.hunter=1;
    session=applySoloAction(session,'select',{targetId:target.id});
    for(const p of session.game.players)session=applySoloAction(session,'confirm',{},p.id);
    return session;
  }
  if (['hunter-execution','hunter-attack','hunter-lover','hunter-wolf'].includes(kind)) {
    let session=createSoloSession('hunter',10);
    if(kind==='hunter-lover') {
      const villagers=session.game.players.filter(p=>p.role==='villager').slice(0,2);
      for(const p of villagers)p.role=p.initialRole=p.apparentRole='lover';
      session.room.composition!.villager-=2;session.room.composition!.lover=2;
    }
    if(kind==='hunter-attack') {
      session=prepareNight(session);
      for(const p of session.game.players.filter(p=>p.alive)) {
        if(['wolf','seer','knight','doctor'].includes(p.role))session=applySoloAction(session,'select',{targetId:p.role==='knight'?session.game.players.find(x=>x.role==='villager')!.id:SOLO_VIEWER,strength:2},p.id);
        session=applySoloAction(session,'confirm',{},p.id);
      }
    } else {
      session=prepareVote(session);
      const wolf=session.game.players.find(p=>p.role==='wolf')!;
      for(const p of session.game.players.filter(p=>p.alive)) {
        session=applySoloAction(session,'select',{targetId:p.id===SOLO_VIEWER?wolf.id:SOLO_VIEWER},p.id);
        session=applySoloAction(session,'confirm',{},p.id);
      }
    }
    if(kind==='hunter-lover'||kind==='hunter-wolf') {
      if(kind==='hunter-wolf')session.game.players.filter(p=>p.role==='wolf').slice(1).forEach(p=>{p.alive=false;});
      const target=session.game.players.find(p=>p.alive&&p.role===(kind==='hunter-lover'?'lover':'wolf'))!;
      session=applySoloAction(session,'select',{targetId:target.id});session=applySoloAction(session,'confirm');
    }
    return session;
  }
  if (kind === 'thief-wolfbound') {
    let session = createSoloSession('thief', 10);
    const target = session.game.players.find(player => player.role === 'villager' && player.id !== SOLO_VIEWER)!;
    target.wolfbound = target.initialWolfbound = true;
    session = applySoloAction(session, 'select', { targetId: target.id });
    for (const player of session.game.players) session = applySoloAction(session, 'confirm', {}, player.id);
    return session;
  }
  if (kind === 'medium-wolfbound') {
    let session = prepareVote(createSoloSession('medium'));
    const target = session.game.players.find(player => player.role === 'villager' && player.id !== SOLO_VIEWER)!;
    target.wolfbound = target.initialWolfbound = true;
    const wolf = session.game.players.find(player => player.role === 'wolf')!;
    for (const actor of session.game.players) {
      session = applySoloAction(session, 'select', { targetId: actor.id === target.id ? wolf.id : target.id }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
  if (kind === 'seer-wolfbound') {
    let session = prepareNight(createSoloSession('seer'));
    const target = session.game.players.find(player => player.role === 'villager' && player.id !== SOLO_VIEWER)!;
    target.wolfbound = target.initialWolfbound = true;
    const attacked = session.game.players.find(player => player.role === 'villager' && player.id !== target.id)!;
    for (const actor of session.game.players.filter(player => player.alive)) {
      if (actor.role === 'wolf') session = applySoloAction(session, 'select', { targetId: attacked.id }, actor.id);
      else if (actor.role === 'seer') session = applySoloAction(session, 'select', { targetId: target.id }, actor.id);
      session = applySoloAction(session, 'confirm', {}, actor.id);
    }
    return session;
  }
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
      else if ((actor.apparentRole ?? actor.role) === 'baker') session = applySoloAction(session, 'select', { targetId: targetFor(session.game, actor.id) }, actor.id);
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
