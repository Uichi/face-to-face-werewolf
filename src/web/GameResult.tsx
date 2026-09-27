import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { GameView } from './game-api.ts';
import type { Room } from './types.ts';
import { teamOf } from '../domain/rules.ts';
import { Scoreboard } from './Points.tsx';
import { roleNames } from './types.ts';

export default function GameResult({ game, room, children }: { game: GameView['public']; room: Room; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }, [game.id]);
  const name = (id: string) => room.members.find(m => m.id === id)?.nickname ?? '参加者';
  const villageWins = game.winner === 'village';
  const winners = game.players.filter(p => p.role && teamOf(p.role) === game.winner);
  const selfWon = winners.some(p => p.id === room.viewerId);
  const wolves = game.players.filter(p => p.alive && p.role === 'wolf').length;
  const villagers = game.players.filter(p => p.alive && p.role !== 'wolf').length;
  const ending = game.ending;
  const lastPlayer = ending && game.players.find(p => p.id === ending.playerId);
  const verb = ending?.cause === 'execution' ? '処刑されました' : ending?.cause === 'attack' ? '人狼に襲撃されました' : '途中脱落しました';
  return <section className={`panel result-panel ${villageWins ? 'village-wins' : 'wolves-win'}`} aria-labelledby="winner-title">
    {ending && <div className="final-event" id="final-event">
      <div className="section-number">最後の出来事 · {ending.day}日目{ending.cause === 'attack' ? 'の夜' : ''}</div>
      <p className="final-person"><strong>{name(ending.playerId)}</strong>さんが<br/>{verb}</p>
      {ending.followedIds?.map(id=><p key={id} className="final-followed"><strong>{name(id)}</strong>さんも後追いで脱落しました。</p>)}
      {lastPlayer?.role && <span className="final-role">役職：{roleNames[lastPlayer.role]}</span>}
    </div>}
    <div className="victory-summary">
      <div className="section-number">{ending ? 'これにより、決着' : '試合の結果'}</div>
      <h2 id="winner-title" ref={heading} tabIndex={-1} aria-describedby={ending ? 'final-event victory-reason' : 'victory-reason'}>{villageWins ? '村側' : '人狼側'}<span>の勝利！</span></h2>
      <p id="victory-reason">{villageWins ? '生存している人狼がいなくなりました。' : '生存している人狼が、人間（狂人を含む）と同数以上になりました。'}</p>
      <div className="final-counts"><span>生存人狼 <b>{wolves}人</b></span><span>生存人間 <b>{villagers}人</b></span></div>
      <p className="your-result">{selfWon ? 'あなたの陣営の勝利です' : 'あなたの陣営は敗北しました'}</p>
    </div>
    <div className="winning-members"><h3>勝ったメンバー</h3><p>脱落した人も、同じ陣営なら勝利です。</p><ul>{winners.map(p => <li key={p.id}>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}</li>)}</ul></div>
    <div className="result-roles"><h3>全員の役職</h3>{game.players.map(p => <div key={p.id} className={p.id === ending?.playerId || ending?.followedIds?.includes(p.id) ? 'last-eliminated' : ''}><span>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}</span><strong>{p.role ? roleNames[p.role] : ''}</strong><small>{ending?.followedIds?.includes(p.id) ? '後追いで脱落' : p.id === ending?.playerId ? '最後に脱落' : p.alive ? '生存' : '脱落'}</small></div>)}</div>
    {game.scores && <Scoreboard room={room} scores={game.scores}/>}
    {children}
  </section>;
}
