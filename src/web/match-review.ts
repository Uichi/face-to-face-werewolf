import type { PublicLogEvent } from '../domain/game.ts';
import type { Score } from '../domain/scoring.ts';
import type { Role } from '../domain/rules.ts';
import { roleNames } from './types.ts';
export function reviewDays(events: PublicLogEvent[]): { day: number; label: string; events: PublicLogEvent[] }[] {
  const days=new Map<number,PublicLogEvent[]>();const seen=new Set<string>();
  for(const event of events){if(seen.has(event.id))continue;seen.add(event.id);const list=days.get(event.day)??[];list.push(event);days.set(event.day,list);}
  return [...days.entries()].sort(([a],[b])=>a-b).map(([day,events])=>({day,label:day===0?'最初の夜':`${day}日目`,events}));
}
export type ScoreExplanation = { victory: string; survival: string; contribution: string; conditions: string[] };
// Only final public scores and final roles are used. Never infer individual targets.
export function explainScore(score: Score, role: Role | undefined, won: boolean | undefined): ScoreExplanation {
  const victory=won===undefined?'試合終了時にサーバーが確定した勝利点です。':won?`${role?roleNames[role]+'として':''}勝利したため、試合開始時の配点で${score.victory}点です。脱落していても対象です。`:'敗北した陣営のため、勝利点は0点です。';
  const survival=score.survival>0?`夜の処理後に生存した実績で${score.survival}点です（最大3点）。敗北しても獲得します。`:'加点対象の夜を越えた生存点は0点です。初夜や昼の処理では加点しません。';
  const contribution=won===false?'貢献点は勝利陣営だけが獲得するため、今回は0点です。行動の実績がなかったことを意味しません。':score.contribution>0?`有効な行動の実績により${score.contribution}点を獲得しました（最大3点）。`:'確定した貢献点は0点です。加点条件と勝利の両方を満たした場合だけ獲得します。';
  const conditions: string[]=[];
  if(role){
    conditions.push(role==='wolf'||role==='madman'?'処刑された村側プレイヤーに投票する。':'処刑された本物の人狼に投票する。');
    if(role==='seer')conditions.push('占いで本物の人狼を発見する。同じ人狼は1回だけ。');
    if(role==='knight')conditions.push('護衛で人狼の襲撃を防ぐ。成功ごとに対象。');
    if(role==='doctor')conditions.push('初回の注射で人狼の襲撃を防ぎ、対象が生存する。');
    if(role==='hunter')conditions.push('発砲で本物の人狼を倒す。');
  }
  return {victory,survival,contribution,conditions};
}
