import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoloSession, applySoloAction, soloResponse } from '../src/web/solo-test.ts';
import { publicThiefReveal } from '../src/web/thief-reveal.ts';
import { resultFrames } from '../src/web/result-presentation.ts';

function exchanged(role='seer') {
 let session=createSoloSession('thief',10);
 const target=session.game.players.find(p=>p.id!=='solo-0'&&p.role===role)!;
 session=applySoloAction(session,'select',{targetId:target.id});
 for(const p of session.game.players)session=applySoloAction(session,'confirm',{},p.id);
 return {session,target};
}
test('怪盗本人だけに交換結果が届き、終了後の全員公開まで相手は漏れない',()=>{
 const {session,target}=exchanged();const view=soloResponse(session).game!;
 assert.equal(view.private!.thiefExchange!.targetId,target.id);assert.equal(view.public.thiefReveal,null);assert.equal(publicThiefReveal(view.public),null);
 session.game.phase='finished';session.game.winner='village';const end=soloResponse(session).game!.public;
 assert.deepEqual(publicThiefReveal(end),{thiefId:'solo-0',targetId:target.id,stolenRole:'seer'});
 const frames=resultFrames({...end,phase:'morning',winner:null},end,id=>id);
 assert.deepEqual(frames.map(f=>f.kind),['victory','thief']);assert.deepEqual(resultFrames(end,end,id=>id),[]);
});
test('村人を奪った場合も正確な相手を公開し、旧SQLの不明な相手は推測しない',()=>{
 const {session,target}=exchanged('villager');session.game.phase='finished';
 const end=soloResponse(session).game!.public;assert.equal(publicThiefReveal(end)!.targetId,target.id);
 delete (end as Partial<typeof end>).thiefReveal;assert.equal(publicThiefReveal(end),null);
});
test('交換なしでは答え合わせを出さず、旧SQLの役職変更は一意な場合だけ表示',()=>{
 const {session}=exchanged();session.game.phase='finished';const end=soloResponse(session).game!.public;
 delete (end as Partial<typeof end>).thiefReveal;assert.equal(publicThiefReveal(end)!.stolenRole,'seer');
 const untouched=createSoloSession();untouched.game.phase='finished';assert.equal(publicThiefReveal(soloResponse(untouched).game!.public),null);
});

test('一人試遊で交換直後と終了後の答え合わせを確認できる',async()=>{
 const {createThiefRevealScenario}=await import('../src/web/solo-test.ts');
 const first=soloResponse(createThiefRevealScenario()).game!;assert.equal(first.public.phase,'firstNight');assert.equal(first.private!.thiefExchange!.stolenRole,'seer');
 const end=soloResponse(createThiefRevealScenario(true)).game!;assert.equal(end.public.phase,'finished');assert.equal(publicThiefReveal(end.public)!.stolenRole,'seer');
});
