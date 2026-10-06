import test from 'node:test';
import assert from 'node:assert/strict';
import { randomCombinations, randomComposition, RANDOM_ROLES } from '../src/domain/random-composition.ts';
import { DEFAULT_COMPOSITIONS, validateComposition, roles } from '../src/domain/rules.ts';
import { createGame, viewFor } from '../src/domain/game.ts';
import { DEFAULT_VICTORY_POINTS } from '../src/domain/scoring.ts';
import { parseFavorite, adaptFavorite } from '../src/web/saved-settings.ts';
import { createRandomSoloSession, soloResponse } from '../src/web/solo-test.ts';
test('5〜13人の全有効組み合わせを重複なく等確率の候補として列挙する',()=>{
 for(let n=5;n<=13;n++){
  const choices=randomCombinations(n,RANDOM_ROLES);assert.equal(new Set(choices.map(c=>JSON.stringify(c))).size,choices.length);
  choices.forEach((c,i)=>{validateComposition(n,c);assert.equal(c.wolf,DEFAULT_COMPOSITIONS[n]!.wolf);assert.ok(c.villager>=1);assert.deepEqual(randomComposition(n,RANDOM_ROLES,()=>i),c);});
  assert.ok(choices.some(c=>c.villager===n-c.wolf));
 }
 assert.equal(randomCombinations(5,[]).length,1);
 assert.ok(randomCombinations(5,['lover']).every(c=>c.lover===0||c.lover===2));
 assert.throws(()=>randomCombinations(5,['wolf']));assert.throws(()=>randomCombinations(5,['seer','seer']));
});
test('配役は主催者・本人・脱落者に秘密で、終了後に開始時の人数を公開する',()=>{
 const comp=randomComposition(10,RANDOM_ROLES,max=>max-1);
 const g=createGame({id:'random',hostId:'0',playerIds:Array.from({length:10},(_,i)=>''+i),composition:comp,randomCandidates:RANDOM_ROLES,wolfboundEnabled:true},0,()=>0);
 g.players[1]!.alive=false;
 for(const p of g.players){const v=viewFor(g,p.id);assert.equal(v.public.composition,null);assert.ok(v.public.players.every(q=>!('role'in q)));assert.equal(v.public.fixedWolves,2);}
 g.phase='finished';assert.deepEqual(viewFor(g,'0').public.composition,comp);
});
test('お気に入りで候補とモードを保存し旧設定と互換、一人試遊も秘密の配役で始まる',()=>{
 const value={version:1,count:10,composition:null,minutes:3,points:{...DEFAULT_VICTORY_POINTS},consecutiveGuard:true,wolfboundEnabled:true,mode:'random',randomCandidates:['seer','lover']};
 const restored=parseFavorite(JSON.stringify(value));assert.ok(restored);assert.equal(adaptFavorite(restored,5,roles).mode,'random');
 assert.equal(parseFavorite(JSON.stringify({...value,randomCandidates:['wolf']})),null);
 assert.equal(parseFavorite(JSON.stringify({...value,mode:undefined,randomCandidates:undefined}))!.mode,undefined);
 const solo=createRandomSoloSession(10);assert.equal(soloResponse(solo).game!.public.composition,null);assert.equal(solo.room.composition,null);
});
