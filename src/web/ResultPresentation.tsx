import ThiefExchangeCards from './ThiefExchangeCards.tsx';
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
  const [held, setHeld] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = frames[index];
  const transition = current?.kind === 'dusk' || current?.kind === 'dawn';
  const modal = !!current && !transition;
  const phase = useRef(game.phaseId);
  useEffect(() => {
    const old = previous.current; previous.current = game;
    const changed = phase.current !== game.phaseId; phase.current = game.phaseId;
    if (paused || document.visibilityState !== 'visible') { previous.current = null; setFrames([]); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setFrames([]); return; }
    // The first snapshot after mounting/reconnecting is a baseline, never a replay.
    if (!old) return;
    const next = resultFrames(old, game, id => room.members.find(m => m.id === id)?.nickname ?? '参加者');
    if (next.length || changed) { setFrames(next); setIndex(0); setHeld(false); }
  }, [game, room.members, paused]);
  useEffect(() => {
    if (!current || held) return;
    const timer = setTimeout(() => setIndex(value => value + 1), current.duration);
    return () => clearTimeout(timer);
  }, [current, held]);
  useEffect(() => {
    if (!modal) return;
    const node = dialog.current; node?.showModal();
    return () => { node?.close(); };
  }, [modal]);
  useEffect(() => {
    const skip = () => setFrames([]);
    const suspend = () => { previous.current = null; skip(); };
    const visible = () => { if (document.visibilityState !== 'visible') suspend(); };
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => { if (media.matches) skip(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('offline', suspend); media.addEventListener('change', reduced);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('offline', suspend); media.removeEventListener('change', reduced); };
  }, []);
  return <><div inert={modal} aria-hidden={modal ? true : undefined}>{allowReplay && ['execution','morning','hunter','finished'].includes(game.phase) && <button className="secondary-button solo-result-replay" onClick={() => { setFrames(latestResultFrames(game, id => room.members.find(m => m.id === id)?.nickname ?? '参加者')); setIndex(0); setHeld(false); }}>結果の演出をもう一度見る（試遊）</button>}{children}</div>{current && transition && <div className={`day-night-transition transition-${current.kind}`} key={`${game.id}:${current.id}:${game.phaseId}`}><div className="celestial-scene" role="img" aria-label={current.kind === 'dusk' ? '夜へ切り替わります' : '朝へ切り替わります'}><svg className="celestial moon" viewBox="0 0 100 100" aria-hidden="true"><path d="M70 13A39 39 0 1 0 87 71 36 36 0 0 1 70 13Z"/></svg><svg className="celestial sun" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="20"/><path d="M50 6v10M50 84v10M6 50h10M84 50h10M19 19l7 7M74 74l7 7M19 81l7-7M74 26l7-7"/></svg></div><button className="text-button transition-skip" onClick={() => setIndex(value => value + 1)}>演出をスキップ</button></div>}{current && !transition && <dialog ref={dialog} className="result-presentation" aria-labelledby="presentation-title" aria-describedby="presentation-detail" onCancel={() => setFrames([])}>
    <div className={`result-scene scene-${current.kind} ${current.team ?? ''}`} key={current.id}>
      <div className="presentation-position" aria-label={`全${frames.length}件中${index + 1}件目`}>{index + 1} / {frames.length}</div>
      <span className="section-number">{current.day !== undefined ? `${current.day}日目 · ` : ''}{current.label ?? '公開された出来事'}</span>
      <h2 id="presentation-title">{current.title}</h2>{current.exchange&&<ThiefExchangeCards key={current.id} thiefName={(room.members.find(m=>m.id===current.exchange!.thiefId)?.nickname??'怪盗')+'さん'} targetName={(room.members.find(m=>m.id===current.exchange!.targetId)?.nickname??'相手')+'さん'} stolenRole={current.exchange.stolenRole} animate/>}<p id="presentation-detail" role="status">{current.detail}</p>
    </div>
    <p className="presentation-reading-state">{held ? '自動送りを停止中です。読めたら「次へ」を押してください。' : '順番に自動で表示します。止めて読むこともできます。'}</p>
    <div className="presentation-controls"><button className="secondary-button" aria-pressed={held} onClick={() => setHeld(value => !value)}>{held ? '自動送りを再開' : '自動送りを止める'}</button><button className="primary" autoFocus onClick={() => setIndex(value => Math.min(value + 1, frames.length))}>{index === frames.length - 1 ? '結果を見る' : '次へ'}</button></div>
    <button className="text-button presentation-skip" onClick={() => setFrames([])}>演出をスキップ</button>
  </dialog>}</>;
}
