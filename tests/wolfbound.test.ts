import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createGame, viewFor } from '../src/domain/game.ts';
import type { Command, Game } from '../src/domain/game.ts';
import { eliminate, getWinner, initialWhite, resolveNight } from '../src/domain/rules.ts';
import type { Composition, Player } from '../src/domain/rules.ts';

const composition: Composition = { villager: 3, wolf: 1, seer: 1, medium: 0, knight: 0, madman: 0, lover: 0, baker: 0, thief: 0 };
const ids = ['a','b','c','w','s'];
const randomWithRoll = (roll: 0|1) => { let calls=0; return (max:number) => calls++ < ids.length ? 0 : calls === ids.length + 1 ? roll : 0; };

test('狼憑きは無効なら0人、有効なら50%抽選で0人または村人1人', () => {
  const off=createGame({id:'off',hostId:'a',playerIds:ids,composition},0,()=>0);
  const absent=createGame({id:'absent',hostId:'a',playerIds:ids,composition,wolfboundEnabled:true},0,randomWithRoll(0));
  const present=createGame({id:'present',hostId:'a',playerIds:ids,composition,wolfboundEnabled:true},0,randomWithRoll(1));
  assert.equal(off.players.some(player=>player.wolfbound),false);
  assert.equal(absent.players.some(player=>player.wolfbound),false);
  assert.equal(present.players.filter(player=>player.wolfbound).length,1);
  assert.equal(present.players.find(player=>player.wolfbound)?.role,'villager');
  assert.throws(()=>createGame({id:'invalid',hostId:'a',playerIds:ids,composition:{...composition,villager:0,medium:1,knight:1,baker:1},wolfboundEnabled:true},0,()=>0),/村人が1人以上/);
});

test('試合中は本人を含めて秘密、終了後だけ狼憑きを公開する', () => {
  const game=createGame({id:'secret',hostId:'a',playerIds:ids,composition,wolfboundEnabled:true},0,randomWithRoll(1));
  const possessed=game.players.find(player=>player.wolfbound)!;
  const live=viewFor(game,possessed.id);
  assert.equal(live.private?.role,'villager');
  assert.equal(JSON.stringify(live).includes('wolfbound'),false);
  game.phase='finished';game.winner='village';
  const ended=viewFor(game,possessed.id);
  assert.equal(ended.public.players.find(player=>player.id===possessed.id)?.wolfbound,true);
});

test('占いは黒、霊媒は白、勝敗では村側として扱う', () => {
  const players:Player[]=[
    {id:'w',role:'wolf',alive:true},{id:'s',role:'seer',alive:true},{id:'m',role:'medium',alive:true},
    {id:'p',role:'villager',alive:true,wolfbound:true},{id:'v',role:'villager',alive:true},
  ];
  const night=resolveNight(players,{attacks:[{actorId:'w',targetId:'v',strength:1}],divination:{actorId:'s',targetId:'p'},protection:null},()=>0);
  assert.equal(night.divination?.isWolf,true);
  const execution=eliminate(players,'p','execution');
  assert.equal(execution.mediumResult?.isWolf,false);
  assert.equal(getWinner(players.map(player=>player.id==='w'?{...player,alive:false}:player)),'village');
  assert.notEqual(initialWhite(players,()=>0)?.targetId,'p');
});

test('怪盗が狼憑きの村人を奪うと秘密状態も移る', () => {
  const thiefComposition:Composition={...composition,villager:2,thief:1};
  let game=createGame({id:'thief',hostId:'a',playerIds:ids,composition:thiefComposition},0,()=>0);
  const thief=game.players.find(player=>player.role==='thief')!;
  const target=game.players.find(player=>player.role==='villager')!;
  target.wolfbound=target.initialWolfbound=true;
  let seq=0;const send=(actorId:string,action:Command['action'])=>{game=applyCommand(game,{gameId:game.id,phaseId:game.phaseId,requestId:String(++seq),actorId,action},seq,()=>0);};
  send(thief.id,{type:'select',targetId:target.id});
  for(const player of game.players)send(player.id,{type:'confirm'});
  assert.equal(game.players.find(player=>player.id===thief.id)?.wolfbound,true);
  assert.equal(game.players.find(player=>player.id===target.id)?.wolfbound,false);
  assert.equal(viewFor(game,thief.id).private?.role,'villager');
});

test('狼憑きの黒判定は占い師の人狼発見貢献に数えない', () => {
  let game=createGame({id:'score',hostId:'a',playerIds:ids,composition},0,()=>0);
  const seer=game.players.find(player=>player.role==='seer')!;
  const wolf=game.players.find(player=>player.role==='wolf')!;
  const possessed=game.players.find(player=>player.role==='villager')!;possessed.wolfbound=true;
  game.phase='night';game.phaseId=20;game.confirmed=[];game.selections={};
  let seq=0;const send=(actorId:string,action:Command['action'])=>{game=applyCommand(game,{gameId:game.id,phaseId:game.phaseId,requestId:String(++seq),actorId,action},seq,()=>0);};
  send(wolf.id,{type:'select',targetId:game.players.find(player=>player.role==='villager'&&player.id!==possessed.id)!.id,strength:1});
  send(seer.id,{type:'select',targetId:possessed.id});
  for(const player of game.players)send(player.id,{type:'confirm'});
  assert.equal(game.secrets.find(secret=>secret.recipientId===seer.id)?.isWolf,true);
  assert.equal(game.scoring?.stats[seer.id]?.contribution??0,0);
});
