import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Command, Game } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS, validateComposition } from '../src/domain/rules.ts';
import { createCheckScenario, createRobbedScenario, SOLO_VIEWER } from '../src/web/solo-test.ts';

function setup(roles=['hunter','wolf','villager','villager','villager']) {
 const comp={...DEFAULT_COMPOSITIONS[5]!,villager:0,seer:0,hunter:0,wolf:0};
 for(const role of roles)comp[role as keyof typeof comp]=(comp[role as keyof typeof comp]??0)+1;
 let game=createGame({id:'h',hostId:'p0',playerIds:roles.map((_,i)=>'p'+i),composition:comp},0,()=>0);
 game.players=roles.map((role,i)=>({id:'p'+i,role:role as Game['players'][number]['role'],initialRole:role as Game['players'][number]['role'],alive:true}));
 let n=0;
 const send=(actorId:string,type:Command['action']['type'],extra={})=>game=applyCommand(game,{gameId:game.id,phaseId:game.phaseId,actorId,requestId:'r'+(++n),action:{type,...extra} as Command['action']},game.lastTime+1,()=>0);
 const execute=()=>{game.phase='vote';game.phaseId++;game.deadline=60000;for(const p of [...game.players]){send(p.id,'select',{targetId:p.id==='p0'?'p1':'p0'});send(p.id,'confirm');}};
 return{get game(){return game;},set game(g:Game){game=g;},send,execute};
}

test('狩人は0〜1人、処刑後に本人だけが発砲し、勝敗・採点は発砲後に確定',()=>{
 assert.throws(()=>validateComposition(5,{...DEFAULT_COMPOSITIONS[5]!,villager:1,hunter:2}),/各0〜1/);
 const f=setup();f.execute();assert.equal(f.game.phase,'hunter');assert.equal(f.game.winner,null);assert.equal(Object.hasOwn(f.game,'scores'),false);
 assert.equal(viewFor(f.game,'p0').private?.role,'hunter');
 assert.equal(viewFor(f.game,'p1').public.players.some(p=>'role'in p),false);
 assert.equal(viewFor(f.game,'p0').public.hunter?.actorId,'p0');
 assert.throws(()=>f.send('p1','select',{targetId:'p2'}),/狩人本人/);
 f.send('p0','select',{targetId:'p2'});f.send('p0','select',{targetId:'p1'});f.send('p0','confirm');
 assert.equal(f.game.phase,'finished');assert.equal(f.game.winner,'village');assert.equal(f.game.lastElimination?.cause,'shot');
 assert.equal(f.game.scores?.find(s=>s.playerId==='p0')?.contribution,1);assert.equal(f.game.scores?.find(s=>s.playerId==='p0')?.victory,5);
 assert.deepEqual(f.game.publicLog?.map(e=>e.kind),['execution','hunterReady','shot']);
});

test('発砲は護衛を無視、恋人を撃つと後追い、狼憑きは発見貢献なし',()=>{
 const lover=createCheckScenario('hunter-lover');assert.equal(lover.game.players.filter(p=>p.role==='lover'&&p.alive).length,0);assert.equal(lover.game.publicLog?.at(-1)?.followedIds?.length,1);
 const f=setup();f.execute();f.game.players.find(p=>p.id==='p2')!.wolfbound=true;f.game.lastGuardTargets={knight:'p2'};
 f.send('p0','select',{targetId:'p2'});f.send('p0','confirm');assert.equal(f.game.players.find(p=>p.id==='p2')?.alive,false);assert.equal(f.game.scoring?.stats.p0?.contribution??0,0);assert.equal(f.game.phase,'execution');
});

test('襲撃からの発砲後に夜の生存点とパンを確定し、撃たれたパン屋からは届かない',()=>{
 const f=setup(['hunter','wolf','baker','knight','seer']);f.game.phase='night';f.game.phaseId++;f.game.deadline=60000;
 f.send('p1','select',{targetId:'p0',strength:2});f.send('p2','select',{targetId:'croissant'});f.send('p3','select',{targetId:'p2'});f.send('p4','select',{targetId:'p1'});
 for(const p of f.game.players)f.send(p.id,'confirm');assert.equal(f.game.phase,'hunter');assert.equal(f.game.day,1);assert.equal(f.game.scoring?.stats.p2?.survival??0,0);
 f.send('p0','select',{targetId:'p2'});f.send('p0','confirm');assert.equal(f.game.day,2);assert.equal(f.game.breadDelivery,null);assert.equal(f.game.scoring?.stats.p2?.survival??0,0);assert.equal(f.game.scoring?.stats.p4?.survival,1);
});

test('時間切れは待機、主催者の中止は期限後だけ、延長・対象退場・二重送信',()=>{
 const f=setup();f.execute();assert.throws(()=>f.send('p0','cancelShot'),/期限後/);
 f.send('p0','select',{targetId:'p1'});f.send('p0','remove',{targetId:'p1'});assert.equal(f.game.phase,'hunter');assert.equal(f.game.selections.p0,undefined);assert.equal(f.game.winner,null);
 f.game.lastTime=f.game.deadline!+1;f.send('p0','extend');assert.throws(()=>f.send('p0','cancelShot'),/期限後/);f.game.lastTime=f.game.deadline!+1;
 const before=f.game;const command:Command={gameId:before.id,phaseId:before.phaseId,actorId:'p0',requestId:'cancel',action:{type:'cancelShot'}};
 f.game=applyCommand(before,command,before.lastTime+1,()=>0);assert.equal(f.game.phase,'finished');const replay=applyCommand(f.game,command,f.game.lastTime+1,()=>0);assert.deepEqual(replay,f.game);
});

test('途中退場は発動せず、怪盗へ狩人能力が移り、奪われた本人は発砲できない',()=>{
 const f=setup();f.send('p0','remove',{targetId:'p0'});assert.notEqual(f.game.phase,'hunter');
 const robbed=createRobbedScenario('hunter');const me=robbed.game.players.find(p=>p.id===SOLO_VIEWER)!;assert.equal(me.role,'villager');assert.equal(viewFor(robbed.game,me.id).private?.role,'hunter');
 const thief=createCheckScenario('thief-hunter');assert.equal(thief.game.players.find(p=>p.id===SOLO_VIEWER)?.role,'hunter');
});

test('狩人の一人試遊5場面が表示できる',()=>{
 for(const kind of ['hunter-execution','hunter-attack','hunter-lover','hunter-wolf','thief-hunter'] as const){const s=createCheckScenario(kind);assert.ok(s.game);}
 const win=createCheckScenario('hunter-wolf');assert.equal(win.game.winner,'village');assert.equal(win.game.lastElimination?.cause,'shot');
});
