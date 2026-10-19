import test from 'node:test';
import assert from 'node:assert/strict';
import { claimRoleReveal, ROLE_REVEAL_KEY } from '../src/web/role-reveal.ts';
function storage(initial:string|null=null){let value=initial;return{getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;},value:()=>value};}
test('初回だけ演出し、別の試合・別の参加者ではそれぞれ初回になる',()=>{
 const s=storage();assert.equal(claimRoleReveal('once-game','viewer-a',s),true);assert.equal(claimRoleReveal('once-game','viewer-a',s),false);
 assert.equal(claimRoleReveal('once-game','viewer-b',s),true);assert.equal(claimRoleReveal('next-game','viewer-a',s),true);
 assert.deepEqual(JSON.parse(s.value()!).map((entry:string)=>JSON.parse(entry)),[['once-game','viewer-a'],['once-game','viewer-b'],['next-game','viewer-a']]);
});
test('再読み込み後に保存済みIDを読めば演出を繰り返さない',()=>{
 const s=storage(JSON.stringify([JSON.stringify(['restored-game','restored-viewer'])]));assert.equal(claimRoleReveal('restored-game','restored-viewer',s),false);assert.equal(ROLE_REVEAL_KEY,'werewolf.role-reveals.v1');
});
test('壊れた保存情報や保存不可でも役職確認を止めず、保存数を制限する',()=>{
 const broken=storage('not-json');assert.equal(claimRoleReveal('broken','a',broken),true);
 const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('quota');}};
 assert.equal(claimRoleReveal('blocked','a',blocked),true);assert.equal(claimRoleReveal('blocked','a',blocked),false);
 const s=storage();for(let i=0;i<105;i++)claimRoleReveal('bounded-'+i,'a',s);assert.equal(JSON.parse(s.value()!).length,100);
});
