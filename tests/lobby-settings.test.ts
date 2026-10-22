import test from 'node:test';
import assert from 'node:assert/strict';
import { lobbySettingsKey,resizeLobbyComposition } from '../src/web/lobby-settings.ts';
import { createSoloSession } from '../src/web/solo-test.ts';
test('参加人数・接続・更新番号・累計の更新で設定を読み直さない',()=>{
 const room=createSoloSession('villager',5).room;room.customComposition=true;
 const key=lobbySettingsKey(room);const next=structuredClone(room);next.members.push({id:'new',nickname:'追加',connected:true});next.revision++;next.members[0]!.points=10;next.members[1]!.connected=false;next.composition!.villager++;
 assert.equal(lobbySettingsKey(next),key);
 for(const change of [{discussionMinutes:8},{hostId:'other'},{consecutiveGuard:false},{compositionMode:'random' as const}])assert.notEqual(lobbySettingsKey({...room,...change}),key);
});
test('村人だけを増減し特殊役職を保持。不成立でも役職を削除せず人数復帰時に調整',()=>{
 const comp=createSoloSession('villager',5).room.composition!;
 const more=resizeLobbyComposition(comp,5,8);assert.equal(more.villager,comp.villager+3);assert.equal(more.wolf,comp.wolf);assert.equal(more.seer,comp.seer);
 assert.deepEqual(resizeLobbyComposition(more,8,5),comp);
 const crowded={...comp,villager:0,wolf:1,seer:1,knight:1,medium:1,doctor:1};
 const small=resizeLobbyComposition(crowded,5,3);assert.equal(small.villager,0);assert.equal(small.doctor,1);
 assert.equal(resizeLobbyComposition(small,3,5).villager,0);assert.equal(resizeLobbyComposition(small,3,6).villager,1);
});
