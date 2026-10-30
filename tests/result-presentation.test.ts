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
 const frames=resultFrames(old,next,name);assert.match(frames[0]!.detail,/\d+票で処刑/);assert.equal(frames.at(-1)?.kind,'victory');assert.equal(frames[0]!.duration,4000);assert.equal(frames[0]!.label,'処刑');assert.equal(frames.at(-1)?.duration,5000);
 assert.deepEqual(resultFrames(next,next,name),[]);assert.deepEqual(resultFrames({...old,id:'another'},next,name),[]);
});
test('夜の直接死亡を先に並べてから後追い・発砲・勝利を表示し重複させない',()=>{
 const next=snapshot();next.publicLog=[{id:'a',day:2,kind:'attack',playerId:'A',followedIds:['B']},{id:'c',day:2,kind:'injection',playerId:'C',followedIds:['D']},{id:'h',day:2,kind:'hunterReady',playerId:'C'},{id:'s',day:2,kind:'shot',playerId:'E',followedIds:['F']}];
 const old={...next,phase:'night' as const,winner:null,publicLog:[]};const frames=resultFrames(old,next,name);
 assert.deepEqual(frames.map(f=>f.id),['dawn','a','c','a:follow:B','c:follow:D','h','s','s:follow:F','victory']);
 assert.deepEqual(frames.filter(f=>f.kind==='death').map(f=>f.label),['人狼の襲撃','注射による死亡','恋人の後追い','恋人の後追い','狩人の発砲','恋人の後追い']);
 next.publicLog[0]!.followedIds=['C'];assert.equal(resultFrames(old,next,name).filter(f=>f.title.startsWith('Cさん')).length,2); // direct death + public hunter notice, never a follow-up
 assert.ok(!resultFrames(old,next,name).some(f=>f.id==='a:follow:C'));
});
test('狩人待ちは勝利にせず、朝の死亡なし・処刑なしも明示する',()=>{
 const next=snapshot();next.phase='hunter';next.winner=null;next.publicLog=[{id:'n',day:1,kind:'noVictim'},{id:'h',day:1,kind:'hunterReady',playerId:'H'}];
 const old={...next,phase:'night' as const,publicLog:[]};const frames=resultFrames(old,next,name);
 assert.equal(frames[0]!.duration,1250);assert.match(frames[1]!.title,/犠牲者はいません/);assert.ok(!frames.some(f=>f.kind==='victory'));
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


test('昼から夜・初夜から昼は文字を増やさず短い切り替えを1回だけ表示',()=>{
 const base=snapshot();const old={...base,phase:'execution' as const,phaseId:10};
 for(const phase of ['night','firstNight'] as const){
  const next={...base,phase,phaseId:11};const frames=resultFrames(old,next,name);
  assert.deepEqual(frames.map(f=>f.kind),['dusk']);assert.equal(frames[0]!.duration,1250);assert.equal(frames[0]!.detail,'');
  assert.deepEqual(resultFrames(next,next,name),[]);
 }
 const first={...base,phase:'firstNight' as const,phaseId:12};
 const day={...base,phase:'discussion' as const,phaseId:13};
 assert.deepEqual(resultFrames(first,day,name).map(f=>f.kind),['dawn']);
 assert.deepEqual(resultFrames({...first,id:'other'},day,name),[]);
});
test('夜明けは既存結果の先頭だけに入り、狩人の発砲後には繰り返さない',()=>{
 const next=snapshot();next.phase='morning';next.winner=null;next.publicLog=[{id:'n',day:2,kind:'noVictim'}];
 const night={...next,phase:'night' as const,phaseId:10,publicLog:[]};
 assert.deepEqual(resultFrames(night,next,name).map(f=>f.kind),['dawn','notice']);
 const hunter={...next,phase:'hunter' as const};assert.deepEqual(resultFrames(hunter,next,name),[]);
});

test('狩人の照準は公開発動、発砲の金色演出は確定した公開発砲だけに付く',()=>{
 const next=snapshot();next.phase='hunter';next.winner=null;next.publicLog=[{id:'ready',kind:'hunterReady',day:1,playerId:'H'}];
 const old={...next,phase:'vote' as const,publicLog:[]};
 assert.equal(resultFrames(old,next,name)[0]!.hunterEffect,'ready');
 next.phase='finished';next.winner='village';next.publicLog.push({id:'shot',kind:'shot',day:1,playerId:'W',actorId:'H',followedIds:['L']});
 const before={...next,phase:'hunter' as const,winner:null,publicLog:next.publicLog.slice(0,1)};
 const frames=resultFrames(before,next,name);
 assert.deepEqual(frames.map(f=>f.id),['shot','shot:follow:L','victory']);assert.equal(frames[0]!.hunterEffect,'shot');assert.ok(frames.slice(1).every(f=>!f.hunterEffect));
 assert.deepEqual(resultFrames(next,next,name),[]);
 next.publicLog=[{id:'cancel',kind:'shotCancelled',day:1,reason:'操作不能'}];assert.ok(resultFrames(old,next,name).every(f=>f.hunterEffect!=='shot'));
});
