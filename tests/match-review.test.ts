import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDays, explainScore } from '../src/web/match-review.ts';
import { createSoloSession, soloResponse } from '../src/web/solo-test.ts';
import type { PublicLogEvent } from '../src/domain/game.ts';

test('振り返りは日付順、同日の公開イベント順を保ち、重複を省く',()=>{
 const events:PublicLogEvent[]=[{id:'a',day:2,kind:'attack',playerId:'p'},{id:'b',day:0,kind:'bread'},{id:'c',day:2,kind:'shot',playerId:'q'},{id:'a',day:2,kind:'attack',playerId:'p'}];
 const original=structuredClone(events);const days=reviewDays(events);
 assert.deepEqual(days.map(d=>[d.label,d.events.map(e=>e.id)]),[['最初の夜',['b']],['2日目',['a','c']]]);
 assert.deepEqual(events,original);assert.deepEqual(reviewDays([]),[]);
});
test('設定が0点の勝利を敗北と説明せず、敗北の貢献0は実績なしと断定しない',()=>{
 const score={playerId:'a',victory:0,survival:2,contribution:0,total:2};
 assert.match(explainScore(score,'villager',true).victory,/勝利したため.*0点/);
 const lost=explainScore(score,'wolf',false);assert.match(lost.contribution,/実績がなかったことを意味しません/);assert.match(lost.survival,/敗北しても/);
});
test('得点の説明は最終役職の条件のみを示し、未知の役職情報を作らない',()=>{
 const score={playerId:'secret-id',victory:5,survival:3,contribution:1,total:9};
 for(const [role,condition] of [['seer','同じ人狼'],['knight','護衛'],['doctor','初回の注射'],['hunter','発砲']] as const){
  const explanation=explainScore(score,role,true);assert.ok(explanation.conditions.some(s=>s.includes(condition)));assert.ok(!JSON.stringify(explanation).includes('secret-id'));
 }
 assert.deepEqual(explainScore(score,undefined,undefined).conditions,[]);
 assert.match(explainScore(score,'madman',true).conditions[0]!,/村側/);
});
test('一人試遊の確定得点は累計に一度だけ表示し、試合中には加算しない',()=>{
 const session=createSoloSession();session.game.scores=[{playerId:'solo-0',victory:5,survival:1,contribution:1,total:7}];
 assert.equal(soloResponse(session).room.members[0]!.points,0);
 session.game.phase='finished';session.room.members[0]!.points=10;
 assert.equal(soloResponse(session).room.members[0]!.points,17);assert.equal(soloResponse(session).room.members[0]!.points,17);
 assert.equal(session.room.members[0]!.points,10);
});
