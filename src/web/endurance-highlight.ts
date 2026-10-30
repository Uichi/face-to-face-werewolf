import type { GameView } from './game-api.ts';

// Read only the viewer's server-confirmed private notice, never public outcomes.
export function canHighlightEndurance(game: GameView, viewerId: string): boolean {
  const notice = game.private?.endurance;
  return game.public.phase === 'morning'
    && game.public.players.some(player => player.id === viewerId && player.alive)
    && game.private?.role === 'bodybuilder'
    && notice?.used === true
    && Number.isInteger(notice.day) && notice.day! >= 1
    && notice.day === game.public.day - 1;
}
