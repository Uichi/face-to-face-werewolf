import { teamOf } from './rules.ts';
import type { Player, Role, Team } from './rules.ts';

export type VictoryPoints = Record<Exclude<Role, 'thief' | 'hunter' | 'doctor'>, number> & { thief?: number; hunter?: number; doctor?: number };
export const DEFAULT_VICTORY_POINTS: Readonly<VictoryPoints> = Object.freeze({ villager: 5, wolf: 6, seer: 5, medium: 5, knight: 5, madman: 6, lover: 5, baker: 5, thief: 5, hunter: 5, doctor: 5 });
export type Score = { playerId: string; victory: number; survival: number; contribution: number; total: number };
// Server-only counters. Never include these in an unfinished game's view.
export type Scoring = { victoryPoints: VictoryPoints; stats: Record<string, { survival: number; contribution: number; discovered: string[] }> };
export function validateVictoryPoints(points: VictoryPoints): void {
  if (!points || !Object.keys(points).every(role => role in DEFAULT_VICTORY_POINTS) || !Object.keys(DEFAULT_VICTORY_POINTS).every(role => (role === 'thief' || role === 'hunter' || role === 'doctor') && points[role] === undefined || Number.isInteger(points[role as Role]) && points[role as Role]! >= 0 && points[role as Role]! <= 10)) throw new Error('勝利点は各役職0〜10の整数で設定してください。');
}
export function recordPoint(scoring: Scoring | undefined, playerId: string, kind: 'survival' | 'contribution', discoveredId?: string): void {
  if (!scoring) return;
  const stats = Object.hasOwn(scoring.stats, playerId) ? scoring.stats[playerId]! : { survival: 0, contribution: 0, discovered: [] };
  if (discoveredId && stats.discovered.includes(discoveredId)) return;
  if (discoveredId) stats.discovered.push(discoveredId);
  stats[kind] = Math.min(3, stats[kind] + 1);
  Object.defineProperty(scoring.stats, playerId, { value: stats, enumerable: true, writable: true, configurable: true });
}
export function calculateScores(scoring: Scoring, players: Player[], winner: Team): Score[] {
  return players.map(p => {
    const won = teamOf(p.role) === winner;
    const stats = Object.hasOwn(scoring.stats, p.id) ? scoring.stats[p.id] : undefined;
    const victory = won ? (scoring.victoryPoints[p.role] ?? DEFAULT_VICTORY_POINTS[p.role] ?? 0) : 0;
    const survival = stats?.survival ?? 0;
    const contribution = won ? stats?.contribution ?? 0 : 0;
    return { playerId: p.id, victory, survival, contribution, total: victory + survival + contribution };
  });
}
