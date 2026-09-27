import type { Score, VictoryPoints } from '../domain/scoring.ts';
import type { Room } from './types.ts';
import { roleNames } from './types.ts';
import type { Role } from '../domain/rules.ts';

import { rankedMembers } from './scoreboard.ts';

export function Scoreboard({ room, scores }: { room: Room; scores?: Score[] | null }) {
  return <div className="scoreboard"><h3>{scores ? '今回のポイントと累計' : 'この部屋の累計ポイント'}</h3>
    {rankedMembers(room).map(member => {
      const score = scores?.find(s => s.playerId === member.id);
      return <div className="score-row" key={member.id}>
        <div className="score-person"><span className="score-rank">{member.rank}位</span><strong>{member.nickname}{member.id === room.viewerId ? '（あなた）' : ''}</strong><span className="score-total">累計 <b>{member.points}</b>点</span></div>
        {score && <div className="score-breakdown"><span>勝利 {score.victory}</span><span>生存 {score.survival}</span><span>貢献 {score.contribution}</span><strong>今回 ＋{score.total}点</strong></div>}
      </div>;
    })}
  </div>;
}
export function ScoringRules({ points }: { points: VictoryPoints }) {
  return <details className="scoring-rules"><summary>ポイントのルール・配点を見る</summary>
    <p>勝利点＋生存点＋貢献点を、試合終了時に加算します。</p>
    <dl className="victory-points">{(Object.keys(roleNames) as Role[]).filter(role => points[role] !== undefined).map(role => <div key={role}><dt>{roleNames[role]}</dt><dd>勝利で{points[role]}点</dd></div>)}</dl>
    <p><b>生存点：</b>初日を除き、夜を越えるたび＋1点（最大3点）。負けても獲得できます。</p>
    <p><b>貢献点：</b>次の成功ごとに＋1点（合計最大3点）。勝った陣営だけが獲得できます。</p>
    <ul><li>村側：処刑された人狼に投票。</li><li>人狼・狂人：処刑された村側に投票。</li><li>占い師：占いで人狼を発見。同じ人狼は1回だけ。</li><li>騎士：護衛で襲撃を防ぐ。連続護衛も対象。</li></ul>
    <p>決選投票があれば最後の投票だけを評価します。脱落しても勝利点とそれまでの実績は有効です。今回の得点は終了後に表示します。</p>
    <p className="small-note">同じ部屋の再戦で累計します。待機室から退出・削除されると得点は消え、再入室は0点です。部屋が削除されると累計も消えます。</p>
  </details>;
}
