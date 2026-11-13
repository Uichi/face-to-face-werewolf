import type { PublicLogEvent } from '../domain/game.ts';
import type { GameView } from './game-api.ts';

export function morningEvents(game: GameView['public']): PublicLogEvent[] {
  const day = game.day - 1;
  const events = (game.publicLog ?? []).filter(event => event.day === day);
  const recordedDeaths = events.filter(event => event.kind === 'attack' || event.kind === 'injection');
  const nightDeaths = (game.nightDeaths ?? [])
    .filter(death => death.day === day && (death.cause === 'attack' || death.cause === 'injection'))
    .map((death): PublicLogEvent => ({
      id: `morning-${death.playerId}`, day, kind: death.cause === 'attack' ? 'attack' : 'injection',
      playerId: death.playerId, followedIds: death.followedIds,
    }));
  const deaths = recordedDeaths.map(event => ({
    ...event,
    followedIds: [...new Set([...(event.followedIds ?? []),
      ...(nightDeaths.find(death => death.playerId === event.playerId)?.followedIds ?? []),
      ...(event.kind === 'attack' ? game.followedIds ?? [] : [])])],
  }) as PublicLogEvent);
  deaths.push(...nightDeaths.filter(death => !deaths.some(event => event.playerId === death.playerId)));
  if (game.victimId && !deaths.some(event => event.kind === 'attack')) {
    deaths.unshift({ id: 'morning-attack', day, kind: 'attack', playerId: game.victimId, followedIds: game.followedIds });
  }
  const nightHunter = events.find(event => event.kind === 'hunterReady' &&
    deaths.some(death => death.playerId === event.playerId));
  const shots = nightHunter ? events.slice(events.indexOf(nightHunter) + 1)
    .filter(event => event.kind === 'shot' || event.kind === 'shotCancelled') : [];
  const bread = game.breadDelivery?.day === day ? game.breadDelivery : null;
  return [
    ...deaths,
    ...(!game.victimId && !deaths.some(event => event.kind === 'attack') ? [{ id: 'morning-no-victim', day, kind: 'noVictim' as const }] : []),
    ...shots,
    ...(bread ? [{ id: 'morning-bread', day, kind: 'bread' as const, breadType: bread.breadType }] : []),
  ];
}
