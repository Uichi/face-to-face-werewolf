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

test('5人未満の旧SQL配列や余分な値を配役の合計に混ぜない',async()=>{
 const {cleanLobbyComposition,lobbyCompositionTotal,initialLobbyComposition}=await import('../src/web/lobby-settings.ts');
 const malformed=[{baker:0},{thief:0},null,{hunter:0}];assert.equal(cleanLobbyComposition(malformed),null);
 const room=createSoloSession('villager',5).room;room.members=room.members.slice(0,1);room.composition=malformed as any;
 const draft=initialLobbyComposition(room);assert.equal(lobbyCompositionTotal(draft),1);assert.equal(draft.wolf,0);
 const comp=cleanLobbyComposition({...draft,wolf:1,metadata:{role:'wolf'},extra:null})!;
 assert.equal(lobbyCompositionTotal(comp),2);assert.ok(!('metadata' in comp));
 assert.equal(lobbyCompositionTotal({...comp,seer:NaN}),null);assert.equal(lobbyCompositionTotal({...comp,seer:'1' as any}),null);
 assert.equal(lobbyCompositionTotal({...comp,seer:1}),3);
});

test('予定人数を基準に標準配役を用意し、参加人数と残り人数を明示する',async()=>{
 const {initialLobbyComposition,plannedRosterMessage}=await import('../src/web/lobby-settings.ts');
 const room=createSoloSession('villager',5).room;room.members=room.members.slice(0,1);room.composition=null;room.plannedPlayers=10;
 const comp=initialLobbyComposition(room);assert.equal(comp.wolf,2);assert.equal(comp.villager,4);
 assert.match(plannedRosterMessage(10,1),/あと9人/);assert.match(plannedRosterMessage(10,10),/全員そろいました/);assert.match(plannedRosterMessage(10,11),/1人多く/);
 const key=lobbySettingsKey(room);assert.equal(lobbySettingsKey({...room,members:[...room.members,{id:'new',nickname:'新規',connected:true}]}),key);
 assert.notEqual(lobbySettingsKey({...room,plannedPlayers:11}),key);
});
