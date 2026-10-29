import type { GameView } from './game-api.ts';

type Props = {
  game: GameView['public']; seconds: number | null; disabled: boolean; hostAlive: boolean;
  name: (id: string) => string;
  onAction: (action: string) => void;
  onConfirm: (text: string, action: string, targetId?: string) => void;
};

export default function HostControls({ game, seconds, disabled, hostAlive, name, onAction, onConfirm }: Props) {
  const phase = game.phase;
  const automatic = ['roles', 'firstNight', 'vote', 'runoff', 'night'].includes(phase);
  const result = phase === 'execution' || phase === 'morning';
  const nextLabel = phase === 'execution' ? '夜を始める' : '昼の議論を始める';
  const canExtend = ['discussion', 'vote', 'runoff', 'night', 'hunter'].includes(phase);
  const instruction = phase === 'discussion' ? '議論がまとまったら、投票を始められます。時間終了でも自動で投票へ進みます。'
    : phase === 'hunter' ? '狩人本人の発砲を待っています。確定すると自動で結果へ進みます。'
    : result ? game.resultConfirmation ? '生存者全員の結果確認を待っています。全員が完了すると自動で進みます。' : phase === 'execution' ? '処刑結果を全員で確認したら、夜を始めてください。' : '朝の結果を全員で確認したら、昼の議論を始めてください。'
    : '全員の確認・行動が完了すると、自動で次へ進みます。主催者が進める操作は不要です。';
  return <section className="panel host-controls" aria-labelledby="host-controls-title">
    <div className="panel-heading"><h2 id="host-controls-title">主催者の進行</h2><span>あなたが主催者です</span></div>
    {!hostAlive && <p className="host-eliminated-note">脱落後も、主催者として進行操作を行えます。</p>}
    <p className="host-instruction">{instruction}</p>
    {(automatic || result && game.resultConfirmation) && <div className="host-progress"><span>全体の操作完了</span><strong>{game.completedCount} / {game.requiredCount}人</strong><progress value={game.completedCount} max={game.requiredCount}/></div>}
    <div className="host-actions">
      {phase === 'discussion' && <button className="primary host-main-action" disabled={disabled} onClick={() => onAction('startVote')}>投票を始める<span>議論を終了して、投票画面へ進みます</span></button>}
      {result && !game.resultConfirmation && <button className="primary host-main-action" disabled={disabled} onClick={() => onAction('next')}>{nextLabel}<span>{phase === 'execution' ? '全員の画面を夜へ進めます' : '全員の画面を昼へ進め、議論タイマーを開始します'}</span></button>}
      {canExtend && <button className="secondary-button" disabled={disabled} onClick={() => onAction('extend')}>残り時間を60秒延長</button>}
    </div>
    {seconds === 0 && ['vote', 'runoff', 'night', 'hunter'].includes(phase) && <p className="inline-note">時間は終了しています。操作は引き続き受け付けています。必要なら延長してください。</p>}
    <details className="host-troubleshooting"><summary>トラブル対応</summary>
      {phase === 'hunter' && seconds === 0 && <div className="host-cancel-shot"><h3>狩人が発砲できないとき</h3><p>発砲を中止して、勝敗判定と次の段階へ進められます。</p><button className="secondary-button" disabled={disabled} onClick={() => onConfirm('狩人の発砲を中止しますか？ 発砲せずに勝敗判定と次の段階へ進みます。', 'cancelShot')}>発砲を中止する</button></div>}
      <details><summary>復帰できない参加者がいるとき</summary><p>対象者を脱落扱いにします。投票・夜の操作中は全員の操作を取り消し、その段階をやり直します。</p>{game.players.filter(player => player.alive).map(player => <button className="remove-player" disabled={disabled} key={player.id} onClick={() => onConfirm(`${name(player.id)}さんを脱落扱いにしますか？ この試合には復帰できません。`, 'remove', player.id)}>{name(player.id)}さんを脱落扱いにする</button>)}</details>
    </details>
  </section>;
}
