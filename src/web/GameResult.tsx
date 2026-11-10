import ThiefExchangeCards from './ThiefExchangeCards.tsx';
import { publicThiefReveal } from './thief-reveal.ts';
import { rankedMembers } from './scoreboard.ts';
import { explainScore } from './match-review.ts';
import RoleImage from './RoleImage.tsx';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { GameView } from './game-api.ts';
import type { Room } from './types.ts';
import { teamOf } from '../domain/rules.ts';
import { Scoreboard } from './Points.tsx';
import { roleNames } from './types.ts';
import PublicLog from './PublicLog.tsx';

const attackReasonLabels = {
  guard: '騎士の護衛',
  doctor: '医者の注射',
  endurance: 'ボディービルダーの耐久',
  injection: '2回目の注射による死亡',
} as const;

export default function GameResult({ game, room, personalNotice, children }: { game: GameView['public']; room: Room; personalNotice?: GameView['personalNotice']; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }, [game.id]);
  const name = (id: string) => room.members.find(m => m.id === id)?.nickname ?? '参加者';
  const villageWins = game.winner === 'village';
  const winners = game.players.filter(p => p.role === 'shishimai' ? p.id === game.shishimaiWinnerId : p.role && teamOf(p.role) === game.winner);
  const shishimaiWinner = game.shishimaiWinnerId;
  const viewerIsShishimai = game.players.some(p => p.id === room.viewerId && p.role === 'shishimai');
  const viewerAlive = game.players.some(p => p.id === room.viewerId && p.alive);
  const shishimaiLossReason = !viewerAlive
    ? '試合終了時に生存していなかったため、追加勝利には届きませんでした。'
    : personalNotice?.kind === 'shishimaiShortfall'
      ? `福を受け取っていない生存者があと${personalNotice.remaining}人いました。`
      : '生き残りましたが、自分以外の生存者全員に福を配れませんでした。';
  const selfWon = winners.some(p => p.id === room.viewerId);
  const wolves = game.players.filter(p => p.alive && p.role === 'wolf').length;
  const villagers = game.players.filter(p => p.alive && p.role !== 'wolf').length;
  const standings=rankedMembers(room);
  const selfStanding=standings.find(member=>member.id===room.viewerId);
  const selfScore=game.scores?.find(score=>score.playerId===room.viewerId);
  const leaders=standings.filter(member=>member.rank===1);
  const explanations=Object.fromEntries((game.scores??[]).map(score=>{const player=game.players.find(p=>p.id===score.playerId);return [score.playerId,explainScore(score,player?.role,player?.role?winners.some(p=>p.id===player.id):undefined)];}));
  const exchange = publicThiefReveal(game);
  const ending = game.ending;
  const failedAttacks = game.phase === 'finished' ? game.failedAttacks ?? [] : [];
  const lastPlayer = ending && game.players.find(p => p.id === ending.playerId);
  const verb = ending?.cause === 'execution' ? '処刑されました' : ending?.cause === 'attack' ? '人狼に襲撃されました' : ending?.cause === 'injection' ? '2回目の注射を受けたため死亡しました' : ending?.cause === 'shot' ? '狩人に撃たれました' : '途中脱落しました';
  const finalVotes = ending?.cause === 'execution' && game.voteResult?.executedId === ending.playerId
    ? game.voteResult.counts[ending.playerId] ?? 0 : null;
  const finalVoteRows = finalVotes === null ? [] : Object.entries(game.voteResult!.counts).sort(([aId, a], [bId, b]) =>
    b - a || room.members.findIndex(member => member.id === aId) - room.members.findIndex(member => member.id === bId));
  const followedNames = ending?.followedIds?.map(name) ?? [];
  const roleLabel = (player: typeof game.players[number], initial = false) => {
    const role = initial ? player.initialRole : player.role;
    const possessed = initial ? player.initialWolfbound : player.wolfbound;
    return role ? `${roleNames[role]}${possessed ? '（狼憑き）' : ''}` : '';
  };
  const drawnRoles = game.compositionMode === 'random' && game.phase === 'finished'
    ? (Object.keys(roleNames) as (keyof typeof roleNames)[]).flatMap(role => {
        const count = game.composition?.[role] ?? 0;
        return count > 0 ? [{ role, count }] : [];
      })
    : [];
  const finalEventText = ending ? `${name(ending.playerId)}さんが${finalVotes === null ? verb : `${finalVotes}票で処刑`}${followedNames.length ? `、恋人の${followedNames.join('さん・')}さんが後追い` : ''}` : '試合終了';
  return <section className={`panel result-panel ${villageWins ? 'village-wins' : 'wolves-win'}`} aria-labelledby="winner-title">
    {shishimaiWinner && <div className="shishimai-victory" aria-labelledby="shishimai-victory-title">
      <RoleImage role="shishimai" compact />
      <div>
        <p className="shishimai-victory-team">{villageWins ? '村側' : '人狼側'}の勝利 ＋ 第三陣営の追加勝利</p>
        <h3 id="shishimai-victory-title">獅子舞も勝利！</h3>
        <p><strong>{name(shishimaiWinner)}さん{shishimaiWinner === room.viewerId ? '（あなた）' : ''}</strong>が生き残り、自分以外の生存者全員に福を配りました。</p>
      </div>
    </div>}
    {viewerIsShishimai && !selfWon && <div className="shishimai-victory" aria-labelledby="shishimai-loss-title">
      <RoleImage role="shishimai" compact />
      <div>
        <p className="shishimai-victory-team">あなただけの結果</p>
        <h3 id="shishimai-loss-title">獅子舞の追加勝利ならず</h3>
        <p>{shishimaiLossReason}</p>
      </div>
    </div>}
    {ending && <div className="final-event" id="final-event">
      <div className="section-number">{ending.cause === 'attack' ? '最後の襲撃結果' : '最後の出来事'} · {ending.day}日目{ending.cause === 'attack' ? 'の夜' : ''}</div>
      <p className="final-person"><strong>{name(ending.playerId)}</strong>さんが<br/>{finalVotes === null ? verb : <><b>{finalVotes}票</b>で処刑されました</>}</p>
      {ending.cause === 'attack' && <p className="final-attack-explanation">{name(ending.playerId)}さんは、人狼の襲撃によって犠牲になりました。</p>}
      {ending.followedIds?.length ? <div className="lover-follow-notice final-followed"><strong>恋人の後追いが発生しました</strong>{ending.followedIds.map(id=><p key={id}><strong>{name(id)}</strong>さんは、{name(ending.playerId)}さんの<strong>恋人だったため</strong>、後追いで脱落しました。</p>)}</div> : null}
      {lastPlayer?.role && <span className="final-role">役職：{roleLabel(lastPlayer)}</span>}
      {finalVoteRows.length > 0 && <div className="final-vote-counts"><h3>最後の投票結果</h3>{finalVoteRows.map(([id, votes])=><div className={id === ending.playerId ? 'executed' : ''} key={id}><span>{name(id)}{id === ending.playerId && <small>処刑</small>}</span><b>{votes}票</b></div>)}<p>誰が誰に投票したかは公開しません。</p></div>}
    </div>}
    <div className="victory-summary">
      <div className="section-number">{ending ? 'これにより、決着' : '試合の結果'}</div>
      <h2 id="winner-title" ref={heading} tabIndex={-1} aria-describedby={ending ? 'final-event victory-reason' : 'victory-reason'}>{villageWins ? '村側' : '人狼側'}<span>の勝利！</span></h2>
      {ending && <div className="decision-flow" aria-label="勝敗が決まった流れ"><div><small>最後の出来事</small><strong>{finalEventText}</strong></div><span aria-hidden="true">↓</span><div><small>処理後の人数</small><strong>人狼 {wolves}人 ／ 人間 {villagers}人</strong></div><span aria-hidden="true">↓</span><div className="decision-winner"><small>勝敗判定</small><strong>{villageWins ? '村側' : '人狼側'}の勝利</strong></div></div>}
      <p id="victory-reason">{villageWins ? '生存している人狼が0人になったため、村側の勝利です。' : `生存人狼${wolves}人が、生存人間${villagers}人と同数以上になったため、人狼側の勝利です。`}</p>
      <div className="final-counts"><span>生存人狼 <b>{wolves}人</b></span><span>生存人間 <b>{villagers}人</b></span></div>
      <p className="your-result">{viewerIsShishimai ? (selfWon ? 'あなたは獅子舞として追加勝利しました' : '獅子舞の追加勝利は達成できませんでした') : selfWon ? 'あなたの陣営の勝利です' : 'あなたの陣営は敗北しました'}</p>
    </div>
    <section className="postgame-hub" aria-labelledby="review-heading"><span className="section-number">ROUND REVIEW</span><h3 id="review-heading">振り返って、もう一戦。</h3>
      {selfScore&&<div className="your-score-review"><div><span>あなたの今回の得点</span><strong>＋{selfScore.total}<small>点</small></strong></div><div className="your-score-parts"><span>勝利 ＋{selfScore.victory}</span><span>生存 ＋{selfScore.survival}</span><span>貢献 ＋{selfScore.contribution}</span></div>{selfStanding&&<p>この部屋の累計 <b>{selfStanding.points}点</b> · <b>{selfStanding.rank}位</b></p>}</div>}
      {game.scores&&<div className="review-leaders"><span>累計1位{leaders.length>1?'（同率）':''}</span><p>{leaders.map(member=>member.nickname).join('、')}</p><small>{leaders[0]?.points??0}点 · 同点は同順位、入室順に表示</small></div>}
      <div className="review-next-game"><h4>次の一戦へ</h4><p>同じメンバー・設定・累計ポイントを引き継いで待機室に戻れます。役職は次の試合で配り直します。</p>{children}</div>
      <nav className="review-navigation" aria-label="振り返りの項目"><a href="#match-review-timeline">日ごとの出来事</a>{failedAttacks.length > 0 && <a href="#match-review-attacks">襲撃が失敗した理由</a>}{game.scores&&<a href="#match-review-scores">順位・得点の理由</a>}{drawnRoles.length > 0 && <a href="#match-review-draw">開始時の抽選配役</a>}<a href="#match-review-roles">最終役職</a></nav>
    </section>
    {drawnRoles.length > 0 && <section id="match-review-draw" aria-labelledby="drawn-roles-title">
      <h3 id="drawn-roles-title">抽選で決まった開始時の配役</h3>
      <p className="review-caption">怪盗の交換が起きる前に配られた役職です。</p>
      <ul className="drawn-role-cards">
        {drawnRoles.map(({role, count}) => <li key={role}>
          <RoleImage role={role} compact />
          <strong>{roleNames[role]}</strong><span>{count}人</span>
        </li>)}
      </ul>
    </section>}
    <div id="match-review-timeline">{game.publicLog?.length?<PublicLog events={game.publicLog} room={room} grouped finalVote={finalVotes!==null&&ending?{playerId:ending.playerId,day:ending.day,count:finalVotes}:undefined}/>:<p className="review-empty">この試合の公開ログは記録されていません。最後の出来事は上の結果をご確認ください。</p>}
      {game.removals.length>0&&<section className="review-removals"><h3>途中退場の記録</h3>{game.removals.map(removal=><p key={`${removal.playerId}-${removal.day}`}>{removal.day}日目：{name(removal.playerId)}さんが途中退場しました。</p>)}</section>}
    </div>
    {failedAttacks.length > 0 && <section id="match-review-attacks" aria-labelledby="attack-review-title">
      <h3 id="attack-review-title">襲撃が失敗した理由</h3>
      <ol className="failed-attack-list">
        {failedAttacks.map(({day, targetId, reasons}) => <li key={day}>
          <span className="section-number">{day}日目の夜</span>
          <strong>人狼が{name(targetId)}さんを襲撃</strong>
          <p>{reasons.includes('injection')
            ? '対象は2回目の注射で死亡し、襲撃による死亡にはなりませんでした。'
            : `${reasons.map(reason => attackReasonLabels[reason]).join('と')}で襲撃を防ぎました。`}</p>
        </li>)}
      </ol>
    </section>}
    {game.scores?<section id="match-review-scores" className="review-scores"><p className="review-caption">累計ポイントの順位です。「得点の理由を見る」で、今回の内訳と採点条件を確認できます。</p><Scoreboard room={room} scores={game.scores} explanations={explanations}/></section>:<p className="review-empty">この試合の得点内訳は記録されていません。</p>}
    {exchange&&<section className="thief-final-reveal"><h3>怪盗の答え合わせ</h3><ThiefExchangeCards thiefName={name(exchange.thiefId)+'さん'} targetName={name(exchange.targetId)+'さん'} stolenRole={exchange.stolenRole}/></section>}
    <div className="winning-members"><h3>勝ったメンバー</h3><p>勝利陣営のメンバーは、脱落していても勝利です。</p><ul>{winners.map(p => <li key={p.id}>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}{p.id === shishimaiWinner ? ' · 獅子舞の追加勝利' : ''}</li>)}</ul></div>
    <div className="result-roles" id="match-review-roles">
      <h3>全員の最終役職</h3>
      {game.players.map(p => {
        const changed = p.initialRole && (p.initialRole !== p.role || !!p.initialWolfbound !== !!p.wolfbound);
        return <div key={p.id} className={p.id === ending?.playerId || ending?.followedIds?.includes(p.id) ? 'last-eliminated' : ''}>
          <span>{name(p.id)}{p.id === room.viewerId ? '（あなた）' : ''}</span>
          <strong className="result-role-label">{roleLabel(p)}{changed && <small>開始時：{roleLabel(p, true)}</small>}</strong>
          <small>{ending?.followedIds?.includes(p.id) ? '恋人の後追いで脱落' : p.id === ending?.playerId ? '最後に脱落' : p.alive ? '生存' : '脱落'}</small>
        </div>;
      })}
    </div>
    {game.phase === 'finished' && game.players.some(player => player.wolfbound || player.initialWolfbound) && <section className="wolfbound-reveal"><h3>狼憑きの正体</h3><RoleImage role="wolfbound" compact/><p>{game.players.filter(player => player.wolfbound).map(player => `${name(player.id)}さん`).join('、')}が狼憑きでした。</p>{game.players.filter(player => player.initialWolfbound && !player.wolfbound).map(player => <p key={player.id}>{name(player.id)}さんの狼憑き状態は、怪盗へ移りました。</p>)}</section>}
  </section>;
}
