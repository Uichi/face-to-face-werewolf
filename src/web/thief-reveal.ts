import type { GameView } from './game-api.ts';
import type { Role } from '../domain/rules.ts';
export type ThiefReveal = { thiefId: string; targetId: string; stolenRole: Role };
export function publicThiefReveal(game: GameView['public']): ThiefReveal | null {
  if (game.phase !== 'finished') return null;
  if (game.thiefReveal) return game.thiefReveal;
  // Compatibility with older SQL: infer only an unambiguous changed target.
  const thief=game.players.find(p=>p.initialRole==='thief'&&p.role&&p.role!=='thief');
  if(!thief?.role)return null;
  const targets=game.players.filter(p=>p.id!==thief.id&&p.initialRole===thief.role&&p.role==='villager'&&(p.initialRole!=='villager'||p.initialWolfbound&&!p.wolfbound));
  return targets.length===1?{thiefId:thief.id,targetId:targets[0]!.id,stolenRole:thief.role}:null;
}
