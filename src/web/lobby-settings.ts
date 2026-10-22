import type { Room } from './types.ts';
import type { Composition } from '../domain/rules.ts';
import { roles, DEFAULT_COMPOSITIONS } from '../domain/rules.ts';
// Presence, points totals and membership revisions are not rule changes.
export function lobbySettingsKey(room: Room): string {
  const custom = room.customComposition && room.composition ? { ...room.composition, villager: 0 } : null;
  return JSON.stringify([room.id,room.hostId,room.plannedPlayers,room.discussionMinutes,room.consecutiveGuard,room.wolfboundEnabled,room.compositionMode,room.customComposition,custom,room.randomCandidates,room.victoryPoints]);
}
export function resizeLobbyComposition(draft: Composition, before: number, after: number): Composition {
  const others=roles.filter(role=>role!=='villager').reduce((total,role)=>total+(typeof draft[role]==='number'?draft[role]!:0),0);
  if(draft.villager===0 && others>before)return {...draft,villager:Math.max(0,after-others)};
  return { ...draft, villager: Number.isFinite(draft.villager) ? Math.max(0,draft.villager + after-before) : draft.villager };
}

// Older SQL wrappers can turn a null composition into an array below five players.
export function cleanLobbyComposition(value: unknown): Composition | null {
  if (!value || typeof value!=='object' || Array.isArray(value)) return null;
  const raw=value as Record<string,unknown>;
  if(typeof raw.villager!=='number' || typeof raw.wolf!=='number')return null;
  return Object.fromEntries(roles.map(role=>[role,raw[role]===undefined?0:typeof raw[role]==='number'?raw[role]:NaN])) as Composition;
}
export function initialLobbyComposition(room: Pick<Room,'composition'|'members'|'plannedPlayers'>): Composition {
  return cleanLobbyComposition(room.composition) ?? { ...(DEFAULT_COMPOSITIONS[room.plannedPlayers??room.members.length] ?? Object.fromEntries(roles.map(role=>[role,role==='villager'?room.members.length:0]))) } as Composition;
}
export function lobbyCompositionTotal(composition: Composition): number | null {
  let sum=0;
  for(const role of roles){const amount=composition[role]??0;if(typeof amount!=='number'||!Number.isInteger(amount)||amount<0)return null;sum+=amount;}
  return sum;
}

export function plannedRosterMessage(planned: number | null | undefined, actual: number): string {
  if(planned==null)return `参加 ${actual}人`;
  return `予定 ${planned}人 / 参加 ${actual}人 · ${actual<planned?`あと${planned-actual}人`:actual===planned?'全員そろいました':`予定より${actual-planned}人多く参加しています`}`;
}
