import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameView } from './game-api.ts';
import type { Room } from './types.ts';
import { latestResultFrames, resultFrames } from './result-presentation.ts';
import type { ResultFrame } from './result-presentation.ts';

export default function ResultPresentation({ game, room, paused, allowReplay = false, children }: { game: GameView['public']; room: Room; paused: boolean; allowReplay?: boolean; children: ReactNode }) {
  const previous = useRef<GameView['public'] | null>(null);
  const [frames, setFrames] = useState<ResultFrame[]>([]);
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = frames[index];
  const phase = useRef(game.phaseId);
  useEffect(() => {
    const old = previous.current; previous.current = game;
    const changed = phase.current !== game.phaseId; phase.current = game.phaseId;
    if (paused || document.visibilityState !== 'visible') { previous.current = null; setFrames([]); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setFrames([]); return; }
    // The first snapshot after mounting/reconnecting is a baseline, never a replay.
    if (!old) return;
    const next = resultFrames(old, game, id => room.members.find(m => m.id === id)?.nickname ?? '参加者');
    if (next.length || changed) { setFrames(next); setIndex(0); }
  }, [game, room.members, paused]);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setIndex(value => value + 1), current.duration);
    return () => clearTimeout(timer);
  }, [current]);
  useEffect(() => {
    if (!current) return;
    const node = dialog.current; node?.showModal();
    return () => { node?.close(); };
  }, [!!current]);
  useEffect(() => {
    const skip = () => setFrames([]);
    const suspend = () => { previous.current = null; skip(); };
    const visible = () => { if (document.visibilityState !== 'visible') suspend(); };
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => { if (media.matches) skip(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('offline', suspend); media.addEventListener('change', reduced);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('offline', suspend); media.removeEventListener('change', reduced); };
  }, []);
  return <><div inert={!!current} aria-hidden={current ? true : undefined}>{allowReplay && ['execution','morning','hunter','finished'].includes(game.phase) && <button className="secondary-button solo-result-replay" onClick={() => { setFrames(latestResultFrames(game, id => room.members.find(m => m.id === id)?.nickname ?? '参加者')); setIndex(0); }}>結果の演出をもう一度見る（試遊）</button>}{children}</div>{current && <dialog ref={dialog} className={`result-presentation ${frames[0]?.kind === 'dawn' ? 'from-night' : ''}`} aria-labelledby="presentation-title" aria-describedby="presentation-detail" onCancel={() => setFrames([])}>
    <div className={`result-scene scene-${current.kind} ${current.team ?? ''}`} key={current.id}>
      <span className="section-number">{current.kind === 'dawn' ? '夜明け' : current.kind === 'victory' ? '決着' : '公開された出来事'}</span>
      <h2 id="presentation-title">{current.title}</h2><p id="presentation-detail" role="status">{current.detail}</p>
    </div>
    <button className="secondary-button" autoFocus onClick={() => setFrames([])}>演出をスキップ</button>
  </dialog>}</>;
}
