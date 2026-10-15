import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNight,eliminate,DEFAULT_COMPOSITIONS,validateComposition} from '../src/domain/rules.ts';
import type {Player} from '../src/domain/rules.ts';
import {createGame,viewFor} from '../src/domain/game.ts';
import {createCheckScenario,soloResponse} from '../src/web/solo-test.ts';
import {randomCombinations} from '../src/domain/random-composition.ts';
const players=():Player[]=>[{id:'w',role:'wolf',alive:true},{id:'b',role:'bodybuilder',alive:true},{id:'d',role:'doctor',alive:true},{id:'k',role:'knight',alive:true},{id:'v',role:'villager',alive:true}];
const night=(used:Record<string,number>={},guard='v',inject='__no_injection__',counts={})=>resolveNight(players(),{attacks:[{actorId:'w',targetId:'b'}],divination:null,protection:{actorId:'k',targetId:guard},injections:[{actorId:'d',targetId:inject}],injectionCounts:counts,enduranceUsed:used},()=>0);
test('最初の襲撃だけ耐え、騎士・医者の保護では耐久を消費しない',()=>{
 assert.equal(night().enduranceSavedId,'b');assert.equal(night().victimId,null);
 assert.equal(night({b:1}).victimId,'b');assert.equal(night({b:1}).enduranceSavedId,null);
 assert.equal(night({},'b').enduranceSavedId,null);assert.equal(night({},'b').knightSuccess,true);
 assert.equal(night({},'v','b').enduranceSavedId,null);assert.deepEqual(night({},'v','b').doctorSuccessIds,['d']);
 const overdose=night({},'b','b',{b:1});assert.equal(overdose.enduranceSavedId,null);assert.equal(overdose.players.find(p=>p.id==='b')!.alive,false);
});
test('処刑・発砲・途中退場を防がず、耐久状態は本人だけに公開',()=>{
 for(const reason of ['execution','shot','disconnect'] as const)assert.equal(eliminate(players(),'b',reason).players.find(p=>p.id==='b')!.alive,false);
 const g=createGame({id:'bb',hostId:'b',playerIds:['b','w','d','k','v'],composition:{...DEFAULT_COMPOSITIONS[5]!,villager:2,bodybuilder:1}},0,()=>0);
 g.players=players();g.enduranceUsed={b:2};const mine=viewFor(g,'b');assert.deepEqual(mine.private!.endurance,{used:true,day:2});
 for(const p of g.players.filter(p=>p.id!=='b')){const v=viewFor(g,p.id);assert.equal(v.private!.endurance,null);assert.ok(!JSON.stringify(v.public).includes('endurance'));}
 g.phase='finished';assert.deepEqual(viewFor(g,'b').personalNotice,{kind:'endurance',day:2});assert.equal(viewFor(g,'w').personalNotice,null);g.phase='night';
 g.players.find(p=>p.id==='b')!.role='villager';g.players.find(p=>p.id==='b')!.decoy=true;g.players.find(p=>p.id==='b')!.apparentRole='bodybuilder';assert.deepEqual(viewFor(g,'b').private!.endurance,{used:false,day:null});
});
test('配役0〜1人、ランダム候補、一人試遊5場面',()=>{
 assert.throws(()=>validateComposition(5,{...DEFAULT_COMPOSITIONS[5]!,villager:1,bodybuilder:2}),/各0〜1/);
 assert.deepEqual(randomCombinations(5,['bodybuilder']).map(c=>c.bodybuilder),[0,1]);
 for(const kind of ['bodybuilder-first','bodybuilder-second','bodybuilder-guard','bodybuilder-doctor','thief-bodybuilder'] as const){const session=createCheckScenario(kind);const view=soloResponse(session).game!;
 if(kind==='bodybuilder-first')assert.equal(view.private!.endurance!.used,true);
 if(kind==='bodybuilder-second')assert.equal(view.public.players.find(p=>p.id===session.room.viewerId)!.alive,false);
 if(kind==='bodybuilder-guard'||kind==='bodybuilder-doctor'||kind==='thief-bodybuilder')assert.equal(view.private!.endurance!.used,false);
 }
});
