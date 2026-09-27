import type { Room } from './types.ts';

export function rankedMembers(room: Room) {
  const sorted = room.members.map((member, seat) => ({ ...member, points: member.points ?? 0, seat })).sort((a, b) => b.points - a.points || a.seat - b.seat);
  return sorted.map(member => ({ ...member, rank: sorted.findIndex(m => m.points === member.points) + 1 }));
}
