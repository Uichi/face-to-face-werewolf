import type { Room } from './types.ts';
import type { Phase } from '../domain/game.ts';
import { NO_EXECUTION_ID } from '../domain/rules.ts';

type Capabilities = Pick<Room,'firstDayNoExecution'|'thiefRole'|'hunterRole'|'doctorRole'|'bodybuilderRole'|'randomComposition'>;
export function canChooseNoExecution(room: Capabilities, phase: Phase, day: number, runoffIds: string[], solo = false): boolean {
  // Later game RPCs implement this rule but no longer return the original flag.
  const supported = room.firstDayNoExecution ?? !!(room.thiefRole || room.hunterRole || room.doctorRole || room.bodybuilderRole || room.randomComposition);
  return (solo || supported) && day === 1 && (phase === 'vote' || phase === 'runoff' && runoffIds.includes(NO_EXECUTION_ID));
}
