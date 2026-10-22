import type { Room } from './types.ts';
import type { Composition } from '../domain/rules.ts';
// Presence, points totals and membership revisions are not rule changes.
export function lobbySettingsKey(room: Room): string {
  const custom = room.customComposition && room.composition ? { ...room.composition, villager: 0 } : null;
  return JSON.stringify([room.id,room.hostId,room.discussionMinutes,room.consecutiveGuard,room.wolfboundEnabled,room.compositionMode,room.customComposition,custom,room.randomCandidates,room.victoryPoints]);
}
export function resizeLobbyComposition(draft: Composition, before: number, after: number): Composition {
  const others=Object.entries(draft).filter(([role])=>role!=='villager').reduce((total,[,n])=>total+n,0);
  if(draft.villager===0 && others>before)return {...draft,villager:Math.max(0,after-others)};
  return { ...draft, villager: Number.isFinite(draft.villager) ? Math.max(0,draft.villager + after-before) : draft.villager };
}
