import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, DEFAULT_COMPOSITIONS, eliminate, initialWhite, resolveNight, teamOf, validateComposition } from '../src/domain/rules.ts';
import type { Composition } from '../src/domain/rules.ts';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Game } from '../src/domain/game.ts';
const composition:Composition={villager:1,wolf:1,seer:1,medium:1,knight:1,madman:0,lover:2,baker:0};
function base(){return createGame({id:'lovers',hostId:'v',playerIds:['v','w','s','m','k','a','b'],composition},0,()=>0);}
function settle(g:Game){g.confirmed=g.players.filter(p=>p.alive).map(p=>p.id);return applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'tick-'+g.phaseId,actorId:null,action:{type:'tick'}},0,()=>0);}

test('恋人は独立した村側の2人組。標準配役に追加せず、0か2人だけを許可',()=>{
 assert.equal(teamOf('lover'),'village');
 for(const comp of Object.values(DEFAULT_COMPOSITIONS))assert.equal(comp.lover,0);
 assert.equal(assignRoles(['v','w','s','m','k','a','b'],composition,()=>0).filter(p=>p.role==='lover').length,2);
 for(const n of [1,3,4,-1,1.5])assert.throws(()=>validateComposition(7,{...composition,villager:3-n,lover:n}));
});

test('相方情報は生存している恋人本人にだけ返し、人狼・主催者・脱落者からは非公開',()=>{
 let g=base();assert.equal(viewFor(g,'a').private!.loverId,'b');assert.equal(viewFor(g,'b').private!.loverId,'a');
 for(const id of ['v','w','s','m','k'])assert.equal(viewFor(g,id).private!.loverId,null);
 assert.ok(viewFor(g,'v').public.players.every(p=>!('role' in p)));
 g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'remove',actorId:'v',action:{type:'remove',targetId:'a'}},0,()=>0);
 assert.equal(viewFor(g,'a').private,null);assert.equal(viewFor(g,'b').private,null);
 assert.deepEqual(g.removals.map(p=>p.playerId),['a','b']);assert.equal(g.players.filter(p=>p.alive).length,5);
});

test('初夜・占い・霊媒は白。霊媒通知は直接処刑された恋人だけ',()=>{
 const g=base();assert.equal(initialWhite(g.players,n=>n-1)!.targetId,'b');
 const night=resolveNight(g.players,{attacks:[{actorId:'w',targetId:'v'}],divination:{actorId:'s',targetId:'a'},protection:{actorId:'k',targetId:'v'}},()=>0);assert.equal(night.divination!.isWolf,false);
 const death=eliminate(g.players,'a','execution');assert.deepEqual(death.followedIds,['b']);assert.equal(death.mediumResult!.targetId,'a');assert.equal(death.mediumResult!.isWolf,false);
 g.phase='vote';g.selections={v:'a',w:'a',s:'a',m:'a',k:'a',a:'v',b:'a'};
 const after=settle(g);assert.equal(after.secrets.filter(r=>r.kind==='medium').length,1);assert.deepEqual(viewFor(after,'v').public.followedIds,['b']);assert.equal(viewFor(after,'a').public.requiredCount,5);
});

test('襲撃は2人とも脱落。護衛成功なら2人とも生存し、相方の護衛だけでは後追いを防げない',()=>{
 for(const guard of ['a','b','v']){
  const g=base();g.phase='night';g.selections={w:'a',s:'w',k:guard};const after=settle(g);
  const saved=guard==='a';assert.equal(after.players.find(p=>p.id==='a')!.alive,saved);assert.equal(after.players.find(p=>p.id==='b')!.alive,saved);
  assert.equal(after.scoring!.stats.a?.survival??0,saved?1:0);assert.equal(after.scoring!.stats.b?.survival??0,saved?1:0);
  assert.deepEqual(viewFor(after,'v').public.followedIds,saved?[]:['b']);
 }
});

test('後追いを含めて勝敗を判定し、最終画面に2人を残す。最後の夜の生存点は生存者だけ',()=>{
 let g=base();g.players=g.players.map(p=>({...p,alive:['v','w','a','b'].includes(p.id)}));g.phase='night';g.selections={w:'a'};
 g=settle(g);assert.equal(g.phase,'finished');assert.equal(g.winner,'wolves');assert.deepEqual(g.lastElimination,{playerId:'a',cause:'attack',day:1,followedIds:['b']});
 assert.equal(g.scores!.find(p=>p.playerId==='w')!.survival,1);assert.equal(g.scores!.find(p=>p.playerId==='a')!.survival,0);assert.equal(g.scores!.find(p=>p.playerId==='b')!.survival,0);
});

test('恋人は対象選択なしの夜確認、村側勝利時に脱落者にも5点。前の後追いを翌朝へ残さない',()=>{
 let g=base();g.phase='night';g.selections={w:'a',s:'w',k:'v'};g=settle(g);
 g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'next-morning',actorId:'v',action:{type:'next'}},0,()=>0);assert.equal(g.phase,'discussion');assert.deepEqual(viewFor(g,'v').public.followedIds,[]);
 g.phase='night';g.selections={w:'v',s:'w',k:'v'};g=settle(g);assert.equal(g.victimId,null);assert.deepEqual(viewFor(g,'v').public.followedIds,[]);
 g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'remove-wolf',actorId:'v',action:{type:'remove',targetId:'w'}},0,()=>0);
 for(const id of ['a','b'])assert.equal(g.scores!.find(s=>s.playerId===id)!.victory,5);
});


test('処刑なしの結果に前の処刑の後追いを表示しない',()=>{
 const g=base();g.phase='execution';g.lastElimination={playerId:'a',cause:'execution',day:1,followedIds:['b']};g.voteResult={counts:{v:2,w:2},executedId:null,runoffIds:[]};
 assert.deepEqual(viewFor(g,'v').public.followedIds,[]);
});
