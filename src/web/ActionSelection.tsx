import { actionSelectionState } from './action-choice.ts';
import type { ActionChoice } from './action-choice.ts';
export default function ActionSelection({ choice, ...state }: { choice: ActionChoice; confirmed: boolean; busy: boolean; pending: boolean; offline: boolean; failed: boolean }) {
  const status = actionSelectionState(state);
  return <div className={`action-selection ${status.accepted ? 'is-confirmed' : 'is-selected'}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="action-selection-status">{status.label}</span>
    <p className="action-selection-target">{status.accepted ? choice.accepted : choice.selected}</p>
    {choice.extra && <p className="action-selection-extra">{choice.extra}</p>}
    <small>{status.hint}</small>
  </div>;
}
