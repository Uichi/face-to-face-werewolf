import test from 'node:test';
import assert from 'node:assert/strict';
import { actionChoice, actionAdvice, actionSelectionState, breadNames } from '../src/web/action-choice.ts';
import { applySoloAction, completeSoloPhase, createRobbedScenario, createSoloSession, soloResponse } from '../src/web/solo-test.ts';
import type { Phase } from '../src/domain/game.ts';
import type { Role } from '../src/domain/rules.ts';
const name = (id: string) => id === 'self' ? '自分' : 'ゆう';
test('投票・決選投票と処刑なしを、選択中・確定済み・確認文で区別する',()=>{
 for (const phase of ['vote','runoff'] as const) {
  const choice=actionChoice(phase,'villager','other',name)!;
  assert.equal(choice.selected,'ゆうさんに投票します');assert.equal(choice.accepted,'ゆうさんに投票済みです');assert.match(choice.question,/ゆうさんへの投票/);
  const no=actionChoice(phase,'villager','__no_execution__',name)!;assert.match(no.selected,/誰も処刑しない/);assert.match(no.accepted,/投票済み/);
 }
});
test('能力ごとの対象・確定ボタン・確認文を表示し、医者の自分・注射なしも扱う',()=>{
 for (const [phase,role,word] of [['night','seer','占'],['night','knight','護衛'],['night','doctor','注射'],['roles','thief','奪'],['hunter','hunter','撃']] as [Phase,Role,string][]) {
  const choice=actionChoice(phase,role,'other',name)!;assert.match(choice.selected,new RegExp(word));assert.match(choice.question,new RegExp(word));assert.match(choice.accepted,/確定/);assert.match(choice.question,/変更できません/);
 }
 assert.equal(actionChoice('night','doctor','self',name)!.selected,'自分さんに注射します');
 const skip=actionChoice('night','doctor','__no_injection__',name)!;assert.equal(skip.selected,'今夜は注射しません');assert.match(skip.accepted,/注射しない/);assert.match(skip.question,/注射しない/);
});
test('パンの全種類を初夜・夜に表示し、無効な値や次の段階の古い選択を出さない',()=>{
 for (const phase of ['firstNight','night'] as const) for (const [id,label] of Object.entries(breadNames)) assert.equal(actionChoice(phase,'baker',id,name)!.selected,`「${label}」を焼きます`);
 assert.equal(actionChoice('night','baker','unknown',name),null);
 for (const phase of ['discussion','execution','morning','finished'] as const) assert.equal(actionChoice(phase,'seer','old-target',name),null);
 assert.equal(actionChoice('night','villager','old-target',name),null);assert.equal(actionChoice('night','seer',null,name),null);
});
test('人狼は襲撃の希望として表現し、サーバーの希望度だけを使用する',()=>{
 for (const strength of [1,2,3]) {const choice=actionChoice('night','wolf','other',name,strength)!;assert.match(choice.selected,/希望します/);assert.match(choice.accepted,/希望しました/);assert.match(choice.extra!,new RegExp(`（${strength}）`));assert.ok(choice.question.includes(choice.extra!));}
 for (const strength of [undefined,null,0,4,1.5]) assert.equal(actionChoice('night','wolf','other',name,strength)!.extra,undefined);
});
test('送信中・結果不明・接続切れ・失敗を確定済みと表示しない',()=>{
 const base={confirmed:false,busy:false,pending:false,offline:false,failed:false};
 for (const key of ['busy','pending','offline','failed'] as const) {const state=actionSelectionState({...base,[key]:true});assert.equal(state.accepted,false);assert.ok(!state.label.startsWith('確定済み'));}
 assert.match(actionSelectionState(base).label,/まだ確定していません/);
 assert.equal(actionSelectionState({...base,confirmed:true}).accepted,true);
});
test('役職別の注意には他人の秘密や実際の注射回数を使わない',()=>{
 assert.match(actionAdvice('doctor')!,/2回目/);assert.match(actionAdvice('doctor')!,/その夜だけ/);
 assert.match(actionAdvice('knight',false)!,/連続護衛なし/);assert.match(actionAdvice('knight',true)!,/連続護衛あり/);
 assert.match(actionAdvice('wolf')!,/仲間/);assert.match(actionAdvice('hunter')!,/護衛では防げません/);assert.equal(actionAdvice('villager'),null);
});
test('サーバー応答の確定状態を使い、再取得と同じ段階の待機中も本人の選択を復元する',()=>{
 let s=createSoloSession('villager',10);s=completeSoloPhase(s,true);s=completeSoloPhase(s,true);s=completeSoloPhase(s,true);
 s=applySoloAction(s,'select',{targetId:'solo-1'});let own=soloResponse(s).game!.private!;assert.equal(own.confirmed,false);
 s=applySoloAction(s,'confirm');const response=soloResponse(s);own=response.game!.private!;
 assert.equal(response.game!.public.phase,'vote');assert.equal(own.confirmed,true);assert.equal(own.selection,'solo-1');
 assert.equal(actionChoice(response.game!.public.phase,own.role,own.selection,name)!.accepted,'ゆうさんに投票済みです');
 assert.equal(JSON.stringify(response.game!.public).includes('selection'),false);
 const restored=soloResponse(structuredClone(s)).game!.private!;assert.equal(restored.confirmed,true);assert.equal(restored.selection,'solo-1');
});
test('医者を奪われても画面上の医者として案内し、村人への交換を知らせない',()=>{
 // A separate snapshot verifies the role-based presentation without inspecting the actual role.
 const own=soloResponse(createRobbedScenario('doctor',10)).game!.private!;
 assert.equal(own.role,'doctor');assert.match(actionChoice('night',own.role,'other',name)!.selected,/注射します/);assert.ok(!actionAdvice(own.role)!.includes('奪'));
});
test('長い名前を省略せずに表示し、選び直した対象だけを確認文に使う',()=>{
 const names=(id:string)=>id==='a'?'長い名前のプレイヤーあいうえおかきくけこ':'別のプレイヤー';
 const first=actionChoice('night','knight','a',names)!;const changed=actionChoice('night','knight','b',names)!;
 assert.ok(first.selected.includes(names('a')));assert.ok(changed.question.includes(names('b')));assert.ok(!changed.question.includes(names('a')));
});
