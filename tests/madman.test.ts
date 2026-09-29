import test from 'node:test';
import assert from 'node:assert/strict';
import { teamOf, getWinner, initialWhite, resolveNight, eliminate, validateComposition, DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';
import type { Player } from '../src/domain/rules.ts';
const players:Player[]=[{id:'w',role:'wolf',alive:true},{id:'c',role:'madman',alive:true},{id:'s',role:'seer',alive:true},{id:'m',role:'medium',alive:true},{id:'v',role:'villager',alive:true}];
test('狂人は勝利陣営が人狼側でも、人数判定では人間として数える',()=>{
 assert.equal(teamOf('madman'),'wolves');assert.equal(teamOf('seer'),'village');
 assert.equal(getWinner(players.slice(0,3)),null);
 assert.equal(getWinner(players.slice(0,2)),'wolves');
 assert.equal(getWinner(players.filter(p=>p.id!=='w')),'village');
 const deadMadman={...players[1]!,alive:false};assert.equal(teamOf(deadMadman.role),'wolves');
});
test('狂人は初夜の白候補になり、占い・霊媒で白と出て、人狼に襲撃される',()=>{
 assert.equal(initialWhite(players,()=>0)!.targetId,'c');
 const night=resolveNight(players,{attacks:[{actorId:'w',targetId:'c'}],divination:{actorId:'s',targetId:'c'},protection:null},()=>0);
 assert.equal(night.victimId,'c');assert.equal(night.divination!.isWolf,false);
 assert.equal(eliminate(players,'c','execution').mediumResult!.isWolf,false);
});
test('標準配役の狂人は8人以上で1人、カスタムでも0〜1人',()=>{
 for(let n=5;n<=13;n++)assert.equal(DEFAULT_COMPOSITIONS[n]!.madman,n>=8?1:0);
 assert.throws(()=>validateComposition(8,{villager:1,wolf:2,seer:1,medium:1,knight:1,madman:2,lover:0,baker:0}));
});
