import {createCheckScenario,soloResponse} from '../src/web/solo-test.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNight, validateComposition, DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';
import type { Player } from '../src/domain/rules.ts';
import { createGame, applyCommand, viewFor } from '../src/domain/game.ts';
import { randomCombinations } from '../src/domain/random-composition.ts';
const players=():Player[]=>[{id:'w',role:'wolf',alive:true},{id:'d',role:'doctor',alive:true},{id:'e',role:'doctor',alive:true},{id:'v',role:'villager',alive:true},{id:'k',role:'knight',alive:true},{id:'h',role:'hunter',alive:true}];
const night=(ps:Player[],targets:string[],counts:Record<string,number>={},attack='v',guard:string|null=null)=>resolveNight(ps,{attacks:[{actorId:'w',targetId:attack,strength:2}],divination:null,protection:{actorId:'k',targetId:guard??'h'},injections:[{actorId:'d',targetId:targets[0]!},{actorId:'e',targetId:targets[1]!}],injectionCounts:counts},()=>0);
test('初回はその夜だけ保護し、日付や医者に関係なく累計2回目で死亡する',()=>{
 const first=night(players(),['v','__no_injection__']);assert.equal(first.victimId,null);assert.deepEqual(first.doctorSuccessIds,['d']);assert.equal(first.injectionCounts.v,1);
 const gap=night(players(),['__no_injection__','__no_injection__'],first.injectionCounts,'h');assert.equal(gap.injectionCounts.v,1);
 const second=night(players(),['__no_injection__','v'],gap.injectionCounts,'h','v');assert.ok(second.deaths.some(d=>d.playerId==='v'&&d.cause==='injection'));assert.equal(second.injectionCounts.v,2);assert.deepEqual(second.doctorSuccessIds,[]);
 assert.equal(night(players(),['__no_injection__','__no_injection__'],first.injectionCounts).victimId,'v');
});
test('同夜2回・自己注射・護衛・同時死亡・恋人の直接死亡を区別する',()=>{
 assert.ok(night(players(),['v','v'],{},'v','v').deaths.some(d=>d.cause==='injection'));
 const self=night(players(),['d','__no_injection__'],{},'d');assert.equal(self.victimId,null);
 const guarded=night(players(),['v','__no_injection__'],{},'v','v');assert.equal(guarded.knightSuccess,true);assert.deepEqual(guarded.doctorSuccessIds,['d']);
 const ps=players();ps.find(p=>p.id==='v')!.role='lover';ps.find(p=>p.id==='h')!.role='lover';
 const both=night(ps,['v','__no_injection__'],{v:1},'h','d');assert.equal(both.deaths.length,2);assert.ok(both.deaths.every(d=>d.followedIds.length===0));
 const follow=night(ps,['v','__no_injection__'],{v:1},'k');assert.deepEqual(follow.deaths.find(d=>d.playerId==='v')!.followedIds,['h']);
});
test('医者2人の配役とランダム候補、累計回数は全端末に秘密',()=>{
 validateComposition(5,{...DEFAULT_COMPOSITIONS[5]!,villager:1,seer:0,doctor:2,wolf:2});
 assert.throws(()=>validateComposition(5,{...DEFAULT_COMPOSITIONS[5]!,villager:0,doctor:3}),/医者/);
 assert.deepEqual(randomCombinations(5,['doctor']).map(c=>c.doctor),[0,1,2]);
 const comp={...DEFAULT_COMPOSITIONS[5]!,villager:2,seer:0,doctor:2};
 const g=createGame({id:'med',hostId:'a',playerIds:['a','b','c','d','e'],composition:comp},0,()=>0);g.injectionCounts={a:1};g.injectionHistory=[{actorId:'a',targetId:'b',day:1}];
 for(const p of g.players)assert.ok(!JSON.stringify(viewFor(g,p.id)).includes('injectionCounts'));
});
test('自己選択と注射なしを確定し、2回目で狩人が発動する',()=>{
 let g=createGame({id:'med',hostId:'a',playerIds:['a','b','c','d','e'],composition:{...DEFAULT_COMPOSITIONS[5]!,villager:2,seer:0,doctor:1,hunter:1}},0,()=>0);
 g.players=['doctor','wolf','hunter','villager','villager'].map((role,i)=>({id:['a','b','c','d','e'][i]!,role:role as Player['role'],alive:true,initialRole:role as Player['role']}));g.phase='night';g.day=3;g.deadline=60000;g.injectionCounts={c:1};
 let seq=0;const cmd=(actorId:string,action:any)=>{g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:''+seq++,actorId,action},++seq,()=>0);};
 cmd('a',{type:'select',targetId:'a'});cmd('a',{type:'select',targetId:'__no_injection__'});cmd('a',{type:'select',targetId:'c'});
 cmd('b',{type:'select',targetId:'d',strength:2});for(const p of [...g.players])cmd(p.id,{type:'confirm'});
 assert.equal(g.phase,'hunter');assert.equal(g.winner,null);assert.equal(g.injectionCounts!.c,2);assert.ok(g.publicLog!.some(e=>e.kind==='injection'));
 const snapshot=JSON.stringify(g);g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'tick',actorId:null,action:{type:'tick'}},++seq,()=>0);assert.equal(g.injectionCounts!.c,2);assert.ok(snapshot);
 cmd('c',{type:'select',targetId:'b'});cmd('c',{type:'confirm'});assert.equal(g.winner,'village');assert.equal(g.scoring!.stats.c!.contribution,1);assert.equal(g.scoring!.stats.a!.survival,1);
});

test('医者の一人試遊5場面を表示できる',()=>{
 for(const kind of ['doctor-protect','doctor-delayed','doctor-double','doctor-hunter','thief-doctor'] as const){const session=createCheckScenario(kind);const v=soloResponse(session).game!;assert.ok(v);if(kind==='doctor-hunter')assert.equal(v.public.phase,'hunter');if(kind==='thief-doctor')assert.equal(v.private!.role,'doctor');if(kind==='doctor-delayed'||kind==='doctor-double')assert.ok(v.public.publicLog.some(e=>e.kind==='injection'));}
});
