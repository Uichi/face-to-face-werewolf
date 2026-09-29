import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { GameView } from './game-api.ts';
import type { Room } from './types.ts';
import { teamOf } from '../domain/rules.ts';
import { Scoreboard } from './Points.tsx';
import { roleNames } from './types.ts';
import PublicLog from './PublicLog.tsx';

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
  const finalVotes = ending?.cause === 'execution' && game.voteResult?.executedId === ending.playerId
    ? game.voteResult.counts[ending.playerId] ?? 0 : null;
  const finalVoteRows = finalVotes === null ? [] : Object.entries(game.voteResult!.counts).sort(([aId, a], [bId, b]) =>
    b - a || room.members.findIndex(member => member.id === aId) - room.members.findIndex(member => member.id === bId));
  const followedNames = ending?.followedIds?.map(name) ?? [];
  const finalEventText = ending ? `${name(ending.playerId)}さんが${finalVotes === null ? verb : `${finalVotes}票で処刑`}${followedNames.length ? `、恋人の${followedNames.join('さん・')}さんが後追い` : ''}` : '試合終了';
  return <section className={`panel result-panel ${villageWins ? 'village-wins' : 'wolves-win'}`} aria-labelledby="winner-title">
    {ending && <div className="final-event" id="final-event">
      <div className="section-number">{ending.cause === 'attack' ? '最後の襲撃結果' : '最後の出来事'} · {ending.day}日目{ending.cause === 'attack' ? 'の夜' : ''}</div>
      <p className="final-person"><strong>{name(ending.playerId)}</strong>さんが<br/>{finalVotes === null ? verb : <><b>{finalVotes}票</b>で処刑されました</>}</p>
      {ending.cause === 'attack' && <p className="final-attack-explanation">{name(ending.playerId)}さんは、人狼の襲撃によって犠牲になりました。</p>}
      {ending.followedIds?.length ? <div className="lover-follow-notice final-followed"><strong>恋人の後追いが発生しました</strong>{ending.followedIds.map(id=><p key={id}><strong>{name(id)}</strong>さんは、{name(ending.playerId)}さんの<strong>恋人だったため</strong>、後追いで脱落しました。</p>)}</div> : null}
      {lastPlayer?.role && <span className="final-role">役職：{roleNames[lastPlayer.role]}</span>}
      {finalVoteRows.length > 0 && <div className="final-vote-counts"><h3>最後の投票結果</h3>{finalVoteRows.map(([id, votes])=><div className={id === ending.playerId ? 'executed' : ''} key={id}><span>{name(id)}{id === ending.playerId && <small>処刑</small>}</span><b>{votes}票</b></div>)}<p>誰が誰に投票したかは公開しません。</p></div>}
    </div>}
    <div className="victory-summary">
      <div className="section-number">{ending ? 'これにより、決着' : '試合の結果'}</div>
      <h2 id="winner-title" ref={heading} tabIndex={-1} aria-describedby={ending ? 'final-event victory-reason' : 'victory-reason'}>{villageWins ? '村側' : '人狼側'}<span>の勝利！</span></h2>
      {ending && <div className="decision-flow" aria-label="勝敗が決まった流れ"><div><small>最後の出来事</small><strong>{finalEventText}</strong></div><span aria-hidden="true">↓</span><div><small>処理後の人数</small><strong>人狼 {wolves}人 ／ 人間 {villagers}人</strong></div><span aria-hidden="true">↓</span><div className="decision-winner"><small>勝敗判定</small><strong>{villageWins ? '村側' : '人狼側'}の勝利</strong></div></div>}
      <p id="victory-reason">{villageWins ? '生存している人狼が0人になったため、村側の勝利です。' : `生存人狼${wolves}人が、生存人間${villagers}人と同数以上になったため、人狼側の勝利です。`}</p>
      <div className="final-counts"><span>生存人狼 <b>{wolves}人</b></span><span>生存人間 <b>{villagers}人</b></span></div>
      <p className="your-result">{selfWon ? 'あなたの陣営の勝利です' : 'あなたの陣営は敗北しました'}</p>
    </div>
    <PublicLog events={game.publicLog??[]} room={room}/>
    <div className="winning-members"><h3>勝ったメンバー</h3><p>脱落した人も、同じ陣営なら勝利です。</p><ul>{winners.map(p => <li key={p.id}>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}</li>)}</ul></div>
    <div className="result-roles"><h3>全員の役職</h3>{game.players.map(p => <div key={p.id} className={p.id === ending?.playerId || ending?.followedIds?.includes(p.id) ? 'last-eliminated' : ''}><span>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}</span><strong>{p.role ? p.initialRole && p.initialRole !== p.role ? `${roleNames[p.initialRole]} → ${roleNames[p.role]}` : roleNames[p.role] : ''}</strong><small>{ending?.followedIds?.includes(p.id) ? '恋人の後追いで脱落' : p.id === ending?.playerId ? '最後に脱落' : p.alive ? '生存' : '脱落'}</small></div>)}</div>
    {game.scores && <Scoreboard room={room} scores={game.scores}/>}
    {children}
  </section>;
}
