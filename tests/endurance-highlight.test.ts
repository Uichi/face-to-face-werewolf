import test from 'node:test';
import assert from 'node:assert/strict';
import { canHighlightEndurance } from '../src/web/endurance-highlight.ts';
import { createCheckScenario, soloResponse, SOLO_VIEWER } from '../src/web/solo-test.ts';
import { claimRoleReveal } from '../src/web/role-reveal.ts';
import { viewFor } from '../src/domain/game.ts';

test('実際に襲撃へ耐えた朝の本人だけが対象、護衛・注射・偽の役職・死亡は対象外',()=>{
 const session=createCheckScenario('bodybuilder-first');const game=soloResponse(session).game!;
 assert.equal(canHighlightEndurance(game,SOLO_VIEWER),true);
 for(const player of session.game.players.filter(p=>p.id!==SOLO_VIEWER))assert.equal(canHighlightEndurance(viewFor(session.game,player.id),player.id),false);
 for(const kind of ['bodybuilder-second','bodybuilder-guard','bodybuilder-doctor','thief-bodybuilder'] as const)assert.equal(canHighlightEndurance(soloResponse(createCheckScenario(kind)).game!,SOLO_VIEWER),false);
 const fake=structuredClone(game);fake.private!.endurance={used:false,day:null};assert.equal(canHighlightEndurance(fake,SOLO_VIEWER),false);
});
test('過去の耐久や昼・夜・終了後は光らせず、実績や公開情報を書き換えない',()=>{
 const game=soloResponse(createCheckScenario('bodybuilder-first')).game!;const original=structuredClone(game);
 canHighlightEndurance(game,SOLO_VIEWER);assert.deepEqual(game,original);
 for(const phase of ['discussion','night','finished'] as const)assert.equal(canHighlightEndurance({...game,public:{...game.public,phase}},SOLO_VIEWER),false);
 game.public.day++;assert.equal(canHighlightEndurance(game,SOLO_VIEWER),false);
});
test('秘密画面を開き直しても繰り返さず、保存内容に役職・日付・対象を入れない',()=>{
 let saved='[]';const storage={getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;}};
 const id='highlight-game:private-highlight';assert.equal(claimRoleReveal(id,'viewer',storage),true);assert.equal(claimRoleReveal(id,'viewer',storage),false);
 assert.deepEqual(JSON.parse(saved),[JSON.stringify([id,'viewer'])]);
 assert.ok(!saved.includes('bodybuilder'));assert.ok(!saved.includes('endurance'));
});
