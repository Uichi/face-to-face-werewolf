import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Game } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';
import { calculateScores, DEFAULT_VICTORY_POINTS, recordPoint, validateVictoryPoints } from '../src/domain/scoring.ts';

function base() {
 return createGame({id:'score-game',hostId:'v0',playerIds:['v0','v1','w0','w1','s','m','k','c'],composition:DEFAULT_COMPOSITIONS[8]!},0,()=>0);
}
function resolve(g:Game) {
 g.confirmed=g.players.filter(p=>p.alive).map(p=>p.id);
 return applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'tick-'+g.phaseId,actorId:null,action:{type:'tick'}},0,()=>0);
}
function votes(target:string):Game {
 const g=base();g.phase='vote';g.selections=Object.fromEntries(g.players.map(p=>[p.id,p.id===target?'v0':target]));return g;
}

test('勝利点は8役職の整数0〜10、勝利陣営の脱落者も対象、敗北は生存点のみ',()=>{
 validateVictoryPoints({...DEFAULT_VICTORY_POINTS});
 for(const value of [-1,11,1.5,NaN]) assert.throws(()=>validateVictoryPoints({...DEFAULT_VICTORY_POINTS,wolf:value}));
 const g=base();for(const p of g.players){p.alive=false;recordPoint(g.scoring,p.id,'survival');recordPoint(g.scoring,p.id,'contribution');}
 for(const winner of ['village','wolves'] as const){
  const scores=calculateScores(g.scoring!,g.players,winner);
  for(const p of g.players){const s=scores.find(s=>s.playerId===p.id)!;const won=(['wolf','madman'].includes(p.role)?'wolves':'village')===winner;assert.equal(s.victory,won?DEFAULT_VICTORY_POINTS[p.role]:0);assert.equal(s.contribution,won?1:0);assert.equal(s.survival,1);assert.equal(s.total,s.victory+s.survival+s.contribution);}
 }
});

test('処刑された人狼への村側投票・処刑された村側への人狼側投票だけを評価',()=>{
 let g=resolve(votes('w0'));for(const p of g.players)assert.equal(g.scoring!.stats[p.id]?.contribution??0,['wolf','madman'].includes(p.role)?0:1);
 g=resolve(votes('v1'));for(const p of g.players)assert.equal(g.scoring!.stats[p.id]?.contribution??0,['wolf','madman'].includes(p.role)?1:0);
 g=resolve(votes('c'));assert.equal(Object.keys(g.scoring!.stats).length,0);
});

test('通常同票では加点せず、決選で処刑が決まった最後の票だけを評価',()=>{
 let g=base();g.phase='vote';g.selections={v0:'w0',v1:'w0',w0:'v0',w1:'v0',s:'w0',m:'w0',k:'v0',c:'v0'};
 g=resolve(g);assert.equal(g.phase,'runoff');assert.deepEqual(g.scoring!.stats,{});
 const tied=structuredClone(g);tied.selections={v0:'w0',v1:'w0',w0:'v0',w1:'v0',s:'w0',m:'w0',k:'v0',c:'v0'};
 const noExecution=resolve(tied);assert.equal(noExecution.voteResult!.executedId,null);assert.deepEqual(noExecution.scoring!.stats,{});
 g.selections={v0:'w0',v1:'w0',w0:'v0',w1:'w0',s:'w0',m:'v0',k:'w0',c:'v0'};
 g=resolve(g);assert.equal(g.scoring!.stats.m,undefined);assert.equal(g.scoring!.stats.k!.contribution,1);assert.equal(g.scoring!.stats.s!.contribution,1);
});

test('初夜は無得点、再占いは重複せず、連続護衛と生存は最大3点',()=>{
 let g=resolve(base());g=resolve(g);assert.deepEqual(g.scoring!.stats,{});
 for(let n=0;n<5;n++){
  g.phase='night';g.selections={w0:'v0',w1:'v0',s:'w0',k:'v0'};g=resolve(g);
 }
 assert.equal(g.scoring!.stats.s!.contribution,1);assert.equal(g.scoring!.stats.k!.contribution,3);
 assert.ok(Object.values(g.scoring!.stats).every(s=>s.survival===3));
 g.phase='night';g.selections={w0:'v0',w1:'v0',s:'w1',k:'v0'};g=resolve(g);assert.equal(g.scoring!.stats.s!.contribution,2);
});

test('襲撃された占い師の発見は成立、最終夜の生存点も加算、途中の実績は非公開',()=>{
 let g=base();g.players=g.players.map(p=>({...p,alive:['v0','v1','w0','w1','s'].includes(p.id)}));g.phase='night';g.selections={w0:'s',w1:'s',s:'w0'};
 for(const p of g.players)assert.equal(viewFor(g,p.id).public.scores,null);
 g=resolve(g);assert.equal(g.winner,'wolves');assert.equal(g.scoring!.stats.s!.contribution,1);assert.equal(g.scoring!.stats.s!.survival,0);
 assert.equal(g.scores!.find(s=>s.playerId==='s')!.total,0);
 assert.equal(g.scores!.find(s=>s.playerId==='w0')!.survival,1);
 assert.equal(g.scores!.find(s=>s.playerId==='c')!.victory,6);
});

test('途中退場前の実績は維持、死亡後に増えず、昼の終了で生存点を増やさない',()=>{
 let g=base();recordPoint(g.scoring,'v0','survival');recordPoint(g.scoring,'v0','contribution');
 g=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'remove',actorId:'v0',action:{type:'remove',targetId:'v0'}},0,()=>0);
 g.phase='night';g.selections={w0:'v1',w1:'v1',s:'w0',k:'v1'};g=resolve(g);
 assert.equal(g.scoring!.stats.v0!.survival,1);assert.equal(g.scoring!.stats.v0!.contribution,1);
 g.players.find(p=>p.id==='w0')!.alive=false;g.phase='vote';g.selections=Object.fromEntries(g.players.filter(p=>p.alive).map(p=>[p.id,p.id==='w1'?'v1':'w1']));
 g=resolve(g);assert.equal(g.winner,'village');assert.deepEqual(g.scores!.find(s=>s.playerId==='v0'),{playerId:'v0',victory:5,survival:1,contribution:1,total:7});
});

test('勝利点は開始時にコピーし、旧試合は採点しない',()=>{
 const points={...DEFAULT_VICTORY_POINTS,villager:0};const g=createGame({id:'g',hostId:'a',playerIds:['a','b','c','d','e'],composition:DEFAULT_COMPOSITIONS[5]!,victoryPoints:points},0,()=>0);points.villager=10;assert.equal(g.scoring!.victoryPoints.villager,0);
 const old=votes('w0');delete old.scoring;old.players.find(p=>p.id==='w1')!.alive=false;const finished=resolve(old);assert.equal(finished.phase,'finished');assert.equal(viewFor(finished,'v0').public.scores,null);
});

test('累計の順位は同点同順位、同点内は入室順、元の参加者順を変更しない',async()=>{
 const {rankedMembers}=await import('../src/web/scoreboard.ts');
 const room={members:[{id:'a',nickname:'A',connected:true,points:5},{id:'b',nickname:'B',connected:true,points:10},{id:'c',nickname:'C',connected:true,points:10},{id:'d',nickname:'D',connected:true,points:0}]} as import('../src/web/types.ts').Room;
 assert.deepEqual(rankedMembers(room).map(m=>[m.id,m.rank]),[['b',1],['c',1],['a',3],['d',4]]);assert.equal(room.members[0]!.id,'a');
});
