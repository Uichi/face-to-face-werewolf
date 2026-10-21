import type { Phase, BreadType } from '../domain/game.ts';
import type { Role } from '../domain/rules.ts';
import { NO_EXECUTION_ID } from '../domain/rules.ts';
export const breadNames: Record<BreadType, string> = { shokupan:'食パン',croissant:'クロワッサン',melonpan:'メロンパン',currypan:'カレーパン',anpan:'あんパン',surprise:'おまかせ' };
export type ActionChoice = { selected: string; accepted: string; question: string; button: string; extra?: string };
const strengthNames = ['','弱く希望（1）','希望（2）','強く希望（3）'];
// Use only the displayed role and this player's server-returned selection, including decoys.
export function actionChoice(phase: Phase, role: Role | undefined, selection: string | null | undefined, name: (id: string) => string, strength?: number | null): ActionChoice | null {
  if (!selection) return null;
  const person = `${name(selection)}さん`;
  let selected: string, accepted: string, question: string, button: string, extra: string | undefined;
  if (phase === 'vote' || phase === 'runoff') {
    const none = selection === NO_EXECUTION_ID;
    selected = none ? '「誰も処刑しない」に投票します' : `${person}に投票します`;
    accepted = none ? '「誰も処刑しない」に投票済みです' : `${person}に投票済みです`;
    question = none ? '「誰も処刑しない」への投票を確定しますか？' : `${person}への投票を確定しますか？`;
    button = 'この投票を確定';
  } else if (phase === 'hunter') {
    selected = `${person}を撃ちます`; accepted = `${person}への発砲を確定しました`; question = `${person}を撃ちますか？`; button = 'この人への発砲を確定';
  } else if (phase === 'roles' && role === 'thief') {
    selected = `${person}の役職を奪います`; accepted = `${person}の役職を奪う選択を確定しました`; question = `${person}の役職を奪いますか？`; button = 'この人の役職を奪う';
  } else if ((phase === 'firstNight' || phase === 'night') && role === 'baker') {
    const bread = breadNames[selection as BreadType]; if (!bread) return null;
    selected = `「${bread}」を焼きます`; accepted = `「${bread}」で確定しました`; question = `「${bread}」を焼きますか？`; button = 'このパンを焼く';
  } else if (phase === 'night') {
    if (role === 'wolf') {
      selected = `${person}を襲撃先として希望します`; accepted = `${person}を襲撃先として希望しました`; question = `${person}を襲撃先として希望しますか？`; button = 'この襲撃希望を確定';
      // Do not invent a value when an older server omits it.
      if (Number.isInteger(strength) && strength! >= 1 && strength! <= 3) extra = `希望度：${strengthNames[strength!]}`;
    } else if (role === 'seer') {
      selected = `${person}を占います`; accepted = `${person}を占う選択を確定しました`; question = `${person}を占いますか？`; button = 'この占い先を確定';
    } else if (role === 'knight') {
      selected = `${person}を護衛します`; accepted = `${person}を護衛する選択を確定しました`; question = `${person}を護衛しますか？`; button = 'この護衛先を確定';
    } else if (role === 'doctor') {
      const skip = selection === '__no_injection__';
      selected = skip ? '今夜は注射しません' : `${person}に注射します`;
      accepted = skip ? '今夜は注射しないと確定しました' : `${person}に注射する選択を確定しました`;
      question = skip ? '今夜は注射しないで確定しますか？' : `${person}に注射しますか？`; button = skip ? '注射しないで確定' : 'この注射先を確定';
    } else return null;
  } else return null;
  return { selected, accepted, question:`${question}${extra ? ` ${extra}。` : ''} 確定後は変更できません。`, button, ...(extra ? {extra} : {}) };
}
export function actionAdvice(role: Role | undefined, consecutiveGuard?: boolean): string | null {
  if (role === 'doctor') return '誰からでも、試合中に2回目の注射を受けると死亡します。初回の注射による襲撃への保護は、その夜だけです。対象の累計注射回数は分かりません。';
  if (role === 'knight') return consecutiveGuard === false ? '連続護衛なし：前の夜に護衛した人は選べません。自己護衛はできません。' : '連続護衛あり：前の夜と同じ人も護衛できます。自己護衛はできません。';
  if (role === 'wolf') return '仲間の人狼も襲撃対象になり、選ばれると死亡します。希望度1〜3を選びます。全員の希望度の合計が最大の対象が襲撃され、同点なら無作為に決まります。';
  if (role === 'hunter') return '発砲は騎士の護衛では防げません。確定すると対象を変更できません。';
  return null;
}
export function actionSelectionState(state: { confirmed: boolean; busy: boolean; pending: boolean; offline: boolean; failed: boolean }): { label: string; hint: string; accepted: boolean } {
  if (state.confirmed) return {label:'確定済み・変更できません',hint:'この段階での選択は受け付けられました。',accepted:true};
  if (state.busy) return {label:'送信中・反映を待っています',hint:'確定の反映が確認できるまでお待ちください。',accepted:false};
  if (state.pending) return {label:'送信結果の確認待ちです',hint:'下の案内から、同じ操作を再送して確認できます。',accepted:false};
  if (state.offline) return {label:'接続を確認しています',hint:'確定の反映が確認できるまでお待ちください。',accepted:false};
  if (state.failed) return {label:'操作を完了できませんでした',hint:'エラーの内容を確認して、もう一度操作してください。',accepted:false};
  return {label:'選択中・まだ確定していません',hint:'選んだだけでは完了しません。内容を確認して確定してください。',accepted:false};
}
