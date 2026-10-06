import type { Phase } from '../domain/game.ts';

type TaskState = {
  phase: Phase; alive: boolean; confirmed: boolean; selected: boolean; roleSeen: boolean;
  resultConfirmation?: boolean; hunterActor?: boolean;
  busy: boolean; retryPending: boolean; offline: boolean;
};
// This public-facing guidance deliberately accepts no role or night target information.
export function currentTask(s: TaskState): { title: string; detail: string; waiting: boolean } {
  const task = (title: string, detail: string, waiting = false) => ({ title, detail, waiting });
  if (s.retryPending) return task('送信結果を確認してください', '下のメッセージから、同じ操作を再送できます。', true);
  if (s.busy) return task('操作を送信しています', '反映されるまで、そのままお待ちください。', true);
  if (s.offline) return task('再接続を待っています', '接続が戻ると、最新の状態を確認します。', true);
  if (s.phase === 'finished') return task('試合の結果を確認しましょう', '勝利陣営と、みんなの役職を振り返れます。');
  if (s.phase === 'execution' && s.resultConfirmation === false) return task('処刑の結果を確認しましょう', '主催者が「次へ進む」を押すと、夜に進みます。');
  if (s.phase === 'morning' && s.resultConfirmation === false) return task('朝の結果を確認しましょう', '主催者が「次へ進む」を押すと、議論が始まります。');
  if (s.phase === 'hunter') return s.hunterActor ? task('最後に撃つ相手を選んでください', '生存者1人を選び、発砲を確定してください。') : task('狩人の発砲を待っています', '発砲と後追いを処理した後に、勝敗を判定します。', true);
  if (!s.alive) return task('静かに見守りましょう', 'あなたは脱落しています。確認や投票は不要です。', true);
  if (s.confirmed) return task('あなたの操作は完了しました', 'ほかの生存者が完了すると、自動で次へ進みます。', true);
  switch (s.phase) {
    case 'roles': return s.roleSeen
      ? task('役職の確認を完了してください', '「役職を確認しました」を押してください。')
      : task('自分の役職を確認してください', '「あなただけの情報」の「タップして表示」を押してください。');
    case 'firstNight': return task('初夜の確認を完了してください', '自分の情報を確認してから「夜の確認を完了」を押してください。');
    case 'discussion': return task('みんなで話し合いましょう', '時間になると自動で投票へ進みます。');
    case 'vote':
    case 'runoff': return s.selected
      ? task('投票を確定してください', '選んだだけでは投票は完了しません。「この人への投票を確定」を押してください。')
      : task(s.phase === 'runoff' ? '決選投票の相手を選んでください' : '投票する相手を選んでください', '相手を選んだあと、確定ボタンを押します。');
    case 'night': return task('夜の操作を完了してください', '「あなただけの情報」を開き、中の案内に沿って確認・確定してください。');
    case 'execution': return task('処刑の結果を確認してください', '下の結果を読んで「結果を確認しました」を押すと、全員の確認後に夜へ進みます。');
    case 'morning': return task('朝の結果を確認してください', '下の結果を読んで「結果を確認しました」を押すと、全員の確認後に議論が始まります。');
  }
}
