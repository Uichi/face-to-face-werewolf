import type { Composition } from '../domain/rules.ts';
export type Member = { id: string; nickname: string; connected: boolean };
export type Room = {
  id: string; code: string; hostId: string; viewerId: string; status: 'waiting' | 'playing' | 'finished';
  revision: number; discussionMinutes: number; composition: Composition | null;
  customComposition: boolean; members: Member[];
};
export const roleNames = { villager: '村人', wolf: '人狼', seer: '占い師', medium: '霊媒師', knight: '騎士' } as const;
