import RoleImage from './RoleImage.tsx';
import { useEffect, useRef, useState } from 'react';
import type { Composition, Role } from '../domain/rules.ts';
import { DEFAULT_VICTORY_POINTS } from '../domain/scoring.ts';
import type { VictoryPoints } from '../domain/scoring.ts';
import { roleNames } from './types.ts';
import { ScoringRules } from './Points.tsx';

// Accept public settings only. Player identities, role assignments and actions never enter this component.
export type HelpSettings = { composition?: Composition | null; discussionMinutes?: number; victoryPoints?: VictoryPoints; loverRole?: boolean };
const roles: { role: Role; team: string; action: string; notes: string }[] = [
  { role: 'villager', team: '村側', action: '会話と投票で、人狼を見つけましょう。', notes: '特別な能力はありません。夜も「あなただけの情報」を開き、確認を完了します。' },
  { role: 'wolf', team: '人狼側', action: '仲間の人狼を確認でき、夜に人狼以外の生存者1人を襲撃します。', notes: '対象を選んで確定します。全員の確定後、襲撃先が違えば選ばれた異なる対象の中から同じ確率で1人に決まります。狂人の正体は分からず、襲撃してしまうこともあります。' },
  { role: 'seer', team: '村側', action: '夜に自分以外の生存者1人を選び、人狼かどうか調べます。', notes: '対象を選んで確定します。同じ人を再び占えます。初夜は対象を選ばず、人狼ではない1人が通知されます。この白通知には狂人も含まれます。結果は本人だけが確認できます。' },
  { role: 'medium', team: '村側', action: '処刑された人が人狼かどうか、処刑後に分かります。', notes: '対象を選ぶ操作はありません。処刑なし・襲撃・途中退場・後追いでは霊媒結果は出ません。結果は本人だけに表示され、夜は確認を完了します。' },
  { role: 'knight', team: '村側', action: '夜に自分以外の生存者1人を護衛します。', notes: '対象を選んで確定します。同じ人を連続して護衛できます。襲撃先と一致すれば犠牲者は出ません。護衛成功の理由や対象は公開されません。初夜は護衛しません。' },
  { role: 'madman', team: '人狼側', action: '人狼を助ける、人間の役職です。人狼側が勝てば狂人も勝利します。', notes: '人狼と互いの正体は分かりません。占い・霊媒では「人狼ではない」と出ます。勝敗判定の人数では人間として数えます。夜の能力はなく、確認だけ行います。' },
  { role: 'lover', team: '村側', action: '2人セットの独立した役職で、お互いが誰か分かります。', notes: '片方が処刑・襲撃・途中退場で脱落すると、もう片方も後追いで脱落します。襲撃対象への護衛が成功すれば2人とも生存しますが、相方だけの護衛では後追いを防げません。占い・霊媒は白。夜は確認のみで、村側の勝利を目指します。' },
  { role: 'baker', team: '村側', action: '生存している朝に、全員へパンが届きます。', notes: 'パン屋の名前は公開されません。パンが届かない朝は、パン屋が配役にいないか、すでに脱落しています。占い・霊媒は白で、夜は確認のみです。' },
];
const sections = [{ id: 'roles', label: '役職' }, { id: 'flow', label: '進め方' }, { id: 'points', label: 'ポイント' }, { id: 'trouble', label: '困ったとき' }] as const;
type Section = typeof sections[number]['id'];

export default function RulesHelp({ settings, onClose }: { settings?: HelpSettings; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>('roles');
  useEffect(() => {
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    node?.showModal(); document.body.style.overflow = 'hidden';
    return () => { node?.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  const changeSection = (next: Section) => { setSection(next); content.current?.scrollTo({ top: 0 }); };
  return <dialog className="rules-dialog" ref={dialog} aria-labelledby="rules-help-title" aria-describedby="rules-help-note" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="rules-help-header"><div><h2 id="rules-help-title">役職・ルール</h2><p id="rules-help-note">全員共通の説明です。</p></div><button className="rules-close" autoFocus onClick={onClose} aria-label="役職・ルールを閉じる">閉じる ×</button></div>
    <nav className="rules-nav" aria-label="説明の項目">{sections.map(item => <button key={item.id} aria-pressed={section === item.id} onClick={() => changeSection(item.id)}>{item.label}</button>)}</nav>
    <div className="rules-help-body" ref={content}>
      {settings && <p className="rules-running-note">説明を開いている間も、ゲームと残り時間は進みます。</p>}
      {section === 'roles' && <section aria-labelledby="rules-roles-title"><h3 id="rules-roles-title">役職一覧</h3><p>村側は人狼を全員見つけ、人狼側は人間を減らすことを目指します。脱落しても、所属する陣営が勝てば勝利です。</p>
        <div className="rules-role-list">{roles.filter(item => item.role !== 'lover' || !settings || settings.loverRole).map(item => <article className="rules-role-card" key={item.role}>
          <RoleImage role={item.role} compact /><div className="rules-role-heading"><h4>{roleNames[item.role]}</h4><span className={item.team === '人狼側' ? 'rules-team wolves' : 'rules-team'}>{item.team}</span>{settings?.composition && <span className="rules-role-count">今回 {settings.composition[item.role] ?? 0}人</span>}</div>
          <p>{item.action}</p><p className="rules-role-notes">{item.notes}</p>
        </article>)}</div><p className="small-note">本人の役職や仲間の名前は、ゲーム画面の「あなただけの情報」で確認してください。</p>
      </section>}
      {section === 'flow' && <section aria-labelledby="rules-flow-title"><h3 id="rules-flow-title">ゲームの進め方</h3>
        <ol className="rules-flow-list">
          <li><h4>役職を確認する</h4><p>自分の役職を確認し、「役職を確認しました」を押します。生存者全員の確認で初夜へ進みます。</p></li>
          <li><h4>初夜の確認</h4><p>襲撃・護衛はありません。占い師には白通知が届きます。全員が自分の情報を確認して、夜の確認を完了します。</p></li>
          <li><h4>昼の議論</h4><p>スマホから顔を上げて話し合います。議論は{settings?.discussionMinutes ?? 3}分{settings ? '（この部屋の設定）' : 'が初期値'}です。主催者は60秒ずつ延長したり、確認操作を挟んで早めに投票へ進めたりできます。</p></li>
          <li><h4>投票・処刑</h4><p>自分以外の生存者1人を選び、投票を確定します。棄権はできません。全員の確定で集計し、最多得票者を処刑します。確定前は選び直せますが、確定後は変更できません。</p><p>最多が同票なら候補者だけを対象に1回決選投票します。候補者本人も投票し、自己投票は禁止です。決選も同票なら処刑しません。公開されるのは得票数だけです。</p></li>
          <li><h4>結果の確認・夜の行動</h4><p>処刑結果は生存者全員の確認で進みます。夜の能力者は「対象選択 → 確定」、能力のない人も夜の確認を完了します。全員完了で、残り時間を待たずに夜を処理します。</p></li>
          <li><h4>朝の確認・次の議論</h4><p>犠牲者を確認し、生存者全員の確認で次の議論へ進みます。占い・護衛・襲撃は同時に処理され、襲撃された占い師の能力も成立します。ただし脱落後は発言できません。</p></li>
        </ol>
        <h3>勝敗が決まるとき</h3><ul><li>生存人狼が0人なら、村側の勝利。</li><li>生存人狼が生存人間と同数以上なら、人狼側の勝利。狂人も人数判定では人間です。</li><li>処刑・夜・途中退場の処理後に判定し、恋人の後追いも含めて成立した時点で終了します。</li></ul>
        <h3>脱落したら</h3><p>発言・投票・能力使用はせず、公開情報だけを見て静かに見守ります。役職は終了後に公開します。個別の投票先・夜の行動履歴は終了後も公開しません。</p>
      </section>}
      {section === 'points' && <section aria-labelledby="rules-points-title"><h3 id="rules-points-title">ポイントの付き方</h3>{settings && !settings.victoryPoints ? <p>この部屋ではポイントを集計しません。</p> : <>
        <p>勝利点・生存点・貢献点を足した点数が、その試合の得点です。{settings ? '下の勝利点はこの部屋の設定です。' : '下の勝利点は初期値です。主催者は待機室で役職別に変更できます。'}</p>
        <ScoringRules points={settings?.victoryPoints ?? DEFAULT_VICTORY_POINTS} expanded/>
        <p>今回の内訳は試合終了後に表示します。主催者は待機室で全員の累計をリセットできます。配点変更は次の試合から適用されます。</p>
      </>}</section>}
      {section === 'trouble' && <section aria-labelledby="rules-trouble-title"><h3 id="rules-trouble-title">困ったとき</h3>
        <h4>時間が0になっても進まない</h4><p>投票と夜の目安は60秒です。未完了の人がいれば待ち続けます。自動投票・自動能力使用はありません。「選ぶ」だけでなく「確定」まで押したか確認してください。主催者は60秒ずつ延長できます。</p>
        <h4>画面を閉じた・通信が切れた</h4><p>同じスマホ・同じブラウザでページを開き直してください。再読み込みで元の席へ戻れます。別端末や、ブラウザの保存情報を消した後の席の引き継ぎはできません。</p>
        <h4>主催者が脱落した</h4><p>脱落しても主催者の操作はできます。主催者が60秒以上切断すると、接続中の参加者へ入室順で主催権限を移します。</p>
        <h4>参加者が戻れない</h4><p>主催者の「復帰できない参加者がいるとき」から脱落扱いにして続けられます。恋人なら相方も後追いで脱落します。投票・夜の途中なら、確定済みも含めて全員が選び直します。決選中は通常投票からやり直します。</p>
        <h4>もう一度遊ぶ</h4><p>終了後、主催者が「同じメンバーで再戦」を選びます。メンバー・設定・累計ポイントを維持し、役職は新しく配ります。</p>
      </section>}
    </div>
  </dialog>;
}
