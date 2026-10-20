import test from 'node:test';
import assert from 'node:assert/strict';
import { resultFrames } from '../src/web/result-presentation.ts';
import { createEndingScenario, soloResponse } from '../src/web/solo-test.ts';
import type { GameView } from '../src/web/game-api.ts';
type PublicGame = GameView['public'];
function snapshot(): PublicGame { return structuredClone(soloResponse(createEndingScenario('village')).game!.public); }
const name = (id:string) => id;
test('処刑の票数から勝利へ進み、同じ結果や別試合を再生しない',()=>{
 const next=snapshot();const old={...next,phase:'vote' as const,winner:null,publicLog:[]};
 const frames=resultFrames(old,next,name);assert.match(frames[0]!.detail,/\d+票で処刑/);assert.equal(frames.at(-1)?.kind,'victory');
 assert.deepEqual(resultFrames(next,next,name),[]);assert.deepEqual(resultFrames({...old,id:'another'},next,name),[]);
});
test('夜の直接死亡を先に並べてから後追い・発砲・勝利を表示し重複させない',()=>{
 const next=snapshot();next.publicLog=[{id:'a',day:2,kind:'attack',playerId:'A',followedIds:['B']},{id:'c',day:2,kind:'injection',playerId:'C',followedIds:['D']},{id:'h',day:2,kind:'hunterReady',playerId:'C'},{id:'s',day:2,kind:'shot',playerId:'E',followedIds:['F']}];
 const old={...next,phase:'night' as const,winner:null,publicLog:[]};const frames=resultFrames(old,next,name);
 assert.deepEqual(frames.map(f=>f.id),['dawn','a','c','a:follow:B','c:follow:D','h','s','s:follow:F','victory']);
 next.publicLog[0]!.followedIds=['C'];assert.equal(resultFrames(old,next,name).filter(f=>f.title.startsWith('Cさん')).length,2); // direct death + public hunter notice, never a follow-up
 assert.ok(!resultFrames(old,next,name).some(f=>f.id==='a:follow:C'));
});
test('狩人待ちは勝利にせず、朝の死亡なし・処刑なしも明示する',()=>{
 const next=snapshot();next.phase='hunter';next.winner=null;next.publicLog=[{id:'n',day:1,kind:'noVictim'},{id:'h',day:1,kind:'hunterReady',playerId:'H'}];
 const old={...next,phase:'night' as const,publicLog:[]};const frames=resultFrames(old,next,name);
 assert.equal(frames[0]!.duration,800);assert.match(frames[1]!.title,/犠牲者はいません/);assert.ok(!frames.some(f=>f.kind==='victory'));
 next.phase='execution';next.publicLog=[{id:'e',day:1,kind:'noExecution'}];assert.match(resultFrames(old,next,name)[0]!.title,/誰も処刑されません/);
});
test('再接続後の既知イベントや過去の夜を次の結果に混ぜない',()=>{
 const next=snapshot();const old={...next,phase:'hunter' as const,winner:null};
 assert.deepEqual(resultFrames(old,next,name).map(f=>f.kind),['victory']);
 next.phase='discussion';assert.deepEqual(resultFrames(old,next,name),[]);
});

test('試遊の明示的な再生は最後の夜だけを見せ、過去の処刑を混ぜない',async()=>{
 const { latestResultFrames }=await import('../src/web/result-presentation.ts');
 const next=snapshot();next.phase='morning';next.winner=null;next.publicLog=[{id:'e',day:1,kind:'execution',playerId:'old'},{id:'a',day:1,kind:'attack',playerId:'A'},{id:'i',day:1,kind:'injection',playerId:'B'}];
 assert.deepEqual(latestResultFrames(next,name).map(f=>f.id),['dawn','a','i']);
});
