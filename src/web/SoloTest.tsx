import { useMemo, useRef, useState } from 'react';
import type { Role } from '../domain/rules.ts';
import GameScreen from './GameScreen.tsx';
import { roleNames } from './types.ts';
import { applySoloAction, completeSoloPhase, createCheckScenario, createEndingScenario, createSoloSession, soloResponse } from './solo-test.ts';
import type { SoloSession } from './solo-test.ts';

const roles: Role[] = ['villager', 'wolf', 'seer', 'medium', 'knight', 'madman', 'lover', 'baker'];
const phaseNames = { roles: '役職確認', firstNight: '初夜', discussion: '昼の議論', vote: '投票', runoff: '決選投票', execution: '処刑結果', night: '夜の行動', morning: '翌朝', finished: '試合終了' } as const;

export default function SoloTest({ onExit }: { onExit: () => void }) {
  const [role, setRole] = useState<Role>('villager');
  const [playerCount, setPlayerCount] = useState(10);
  const [session, setSession] = useState<SoloSession | null>(null);
  const [autoTarget, setAutoTarget] = useState('');
  const sessionRef = useRef<SoloSession | null>(null);
  const update = (next: SoloSession | null) => { sessionRef.current = next; setSession(next); };
  const response = useMemo(() => session ? soloResponse(session) : null, [session]);
  const driver = response ? { response, command: async (action: string, payload: Record<string, unknown>) => {
    const next = applySoloAction(sessionRef.current!, action, payload); update(next); return soloResponse(next);
  } } : undefined;

  if (!session || !response || !driver) return <section className="solo-setup entry-card">
    <button className="text-button back" onClick={onExit}>← トップへ</button><div className="section-number">SOLO PLAYTEST</div><h1>ひとりで試遊する。</h1>
    <p className="muted">あなた以外の参加者を自動操作して、5〜13人ゲームの画面と進行を確認できます。部屋やポイントは保存されません。</p>
    <label>試遊する人数<select value={playerCount} onChange={event => setPlayerCount(Number(event.target.value))}>{Array.from({length:9},(_,index)=>index+5).map(value=><option value={value} key={value}>{value}人（自動操作{value-1}人）</option>)}</select></label>
    <label>確認したい自分の役職<select value={role} onChange={event => setRole(event.target.value as Role)}>{roles.map(value => <option value={value} key={value}>{roleNames[value]}</option>)}</select></label>
    <button className="primary" onClick={() => update(createSoloSession(role, playerCount))}>{playerCount}人で最初から試遊を始める</button>
    <div className="solo-scenarios"><h2>確認したい場面から始める</h2><p>通常と同じ判定処理を通して、選んだ場面をすぐ表示します。</p>
      <button className="secondary-button" onClick={() => update(createEndingScenario('village'))}>人狼を処刑 → 村側勝利</button>
      <button className="secondary-button" onClick={() => update(createEndingScenario('wolves'))}>村人を処刑 → 人狼側勝利</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('lover-execution'))}>恋人を処刑 → 相方が後追い</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('lover-attack'))}>恋人を襲撃 → 相方が後追い</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('guard-success'))}>騎士の護衛成功 → 犠牲者なし</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('guard-failure'))}>騎士の護衛失敗 → 襲撃の犠牲者</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('runoff'))}>同票 → 決選投票</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('no-execution'))}>初日「誰も処刑しない」→ 処刑なし</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('no-execution-runoff'))}>処刑なしと同票 → 決選投票</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('seer-wolf'))}>占い師が人狼を発見</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('baker-alive'))}>パン屋が生存 → パンが届く朝</button>
      <button className="secondary-button" onClick={() => update(createCheckScenario('baker-dead'))}>パン屋が襲撃 → パンが届かない朝</button>
    </div>
  </section>;

  const game = session.game;
  const incompleteBots = game.players.filter(player => player.alive && player.id !== response.room.viewerId && !game.confirmed.includes(player.id)).length;
  return <><aside className="solo-toolbar" aria-label="ひとり試遊の操作">
    <div><strong>ひとり試遊中</strong><span>{game.day}日目・{phaseNames[game.phase]}</span></div>
    {game.phase !== 'finished' && <div className="solo-toolbar-actions">
      {['vote','runoff'].includes(game.phase) && <label className="solo-target">自動投票先<select value={autoTarget} onChange={event => setAutoTarget(event.target.value)}><option value="">人狼を優先</option>{game.day===1&&(game.phase==='vote'||game.runoffIds.includes('__no_execution__'))&&<option value="__no_execution__">誰も処刑しない</option>}{game.players.filter(player => player.alive).map(player => <option key={player.id} value={player.id}>{response.room.members.find(member => member.id === player.id)?.nickname}</option>)}</select></label>}
      <button className="secondary-button" disabled={incompleteBots === 0 || game.phase === 'discussion'} onClick={() => update(completeSoloPhase(sessionRef.current!, false, autoTarget || undefined))}>テスト{game.players.length-1}人を完了</button><button className="secondary-button" onClick={() => update(completeSoloPhase(sessionRef.current!, true, autoTarget || undefined))}>この段階を全員自動で進める</button></div>}
    <button className="text-button" onClick={() => update(null)}>役職を選び直す</button><button className="text-button" onClick={onExit}>試遊を終了</button>
  </aside><GameScreen key={game.id} room={response.room} onRoom={() => {}} onHome={() => update(null)} localDriver={driver}/></>;
}
