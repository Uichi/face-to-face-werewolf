import type { VictoryPoints } from '../domain/scoring.ts';
import type { Composition } from '../domain/rules.ts';
export type Member = { id: string; nickname: string; connected: boolean; points?: number };
export type Room = {
  id: string; code: string; hostId: string; viewerId: string; status: 'waiting' | 'playing' | 'finished';
  revision: number; discussionMinutes: number; composition: Composition | null;
  loverRole?: boolean;
  bakerRole?: boolean;
  breadChoices?: boolean;
  thiefRole?: boolean;
  firstDayNoExecution?: boolean;
  consecutiveGuard?: boolean;
  wolfboundEnabled?: boolean;
  victoryPoints?: VictoryPoints;
  customComposition: boolean; members: Member[];
};
export const roleNames = { villager: '村人', wolf: '人狼', seer: '占い師', medium: '霊媒師', knight: '騎士', madman: '狂人', lover: '恋人', baker: 'パン屋', thief: '怪盗' } as const;
