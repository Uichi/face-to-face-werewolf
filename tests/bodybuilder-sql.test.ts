import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomCombinations, RANDOM_ROLES } from '../src/domain/random-composition.ts';

test('ボディービルダーSQL：耐久・保護・秘密・怪盗・再送・再戦',async t=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;
 create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 await db.exec(await readFile(new URL('202610150025_bodybuilder.sql',dir),'utf8'));
 const users=Array.from({length:6},()=>randomUUID());for(const u of users)await db.query('insert into auth.users values($1)',[u]);
 const user=async(i:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users[i]!]);await db.exec('set role authenticated');};
 const raw=async(fn:string,action:string,payload:object)=>(await db.query<{data:any}>(`select public.${fn}($1,$2::jsonb)data`,[action,JSON.stringify(payload)])).rows[0]!.data;
 await user(0);let response=await raw('lobby_command_bodybuilder','create',{nickname:'主催',requestId:randomUUID()});
 for(let i=1;i<5;i++){await user(i);response=await raw('lobby_command_bodybuilder','join',{code:response.room.code,nickname:'参加'+i});}
 const roomId=response.room.id;const ids=response.room.members.map((m:any)=>m.id);
 const state=async()=>{await db.exec('reset role');return(await db.query<{state:any}>('select state from app_private.games where room_id=$1',[roomId])).rows[0]!.state;};
 const save=async(g:any)=>{await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),roomId]);await db.query("update app_private.rooms set status='playing' where id=$1",[roomId]);};
 const call=async(i:number,action:string,extra:object={},requestId=randomUUID())=>{const g=await state();await user(i);return response=await raw('game_command_bodybuilder',action,{roomId,gameId:g.id,phaseId:g.phaseId,requestId,...extra});};
 try{
 await user(0);response=await raw('lobby_command_bodybuilder','get',{roomId});
 response=await raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,compositionMode:'custom',composition:{villager:3,wolf:1,seer:0,medium:0,knight:0,madman:0,lover:0,baker:0,thief:0,hunter:0,doctor:0,bodybuilder:1},discussionMinutes:3,victoryPoints:response.room.victoryPoints});assert.equal(response.room.bodybuilderRole,true);assert.equal(response.room.victoryPoints.bodybuilder,5);
 response=await raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId:randomUUID()});const original=await state();
 const setup=async(roles=['bodybuilder','wolf','knight','doctor','villager'],used?:object)=>{const g=structuredClone(original);g.id=randomUUID();g.phase='night';g.phaseId=20;g.day=3;g.deadline=Date.now()+60000;g.players=roles.map((role,i)=>({id:ids[i],role,initialRole:role,apparentRole:role,alive:true}));g.injectionCounts={};g.injectionHistory=[];if(used)g.enduranceUsed=used;g.confirmed=[];g.selections={};g.publicLog=[];g.scoring.stats={};await save(g);return g;};
 const night=async(choices:Record<string,string>)=>{for(let i=0;i<5;i++){if(choices[i]!==undefined)await call(i,'select',{targetId:choices[i],strength:2});await call(i,'confirm');}};
 await t.test('初回だけ耐え、本人のみ使用済みと日付を確認でき、再接続でも維持する',async()=>{
  await setup();await night({'1':ids[0],'2':ids[4],'3':'__no_injection__'});let g=await state();assert.equal(g.phase,'morning');assert.equal(g.players[0].alive,true);assert.equal(g.victimId,null);assert.equal(g.enduranceUsed[ids[0]],3);assert.equal(g.publicLog.filter((e:any)=>e.kind==='noVictim').length,1);assert.ok(g.publicLog.every((e:any)=>!e.kind.includes('body')));
  await call(0,'get');assert.deepEqual(response.game.private.endurance,{used:true,day:3});assert.ok(!JSON.stringify(response.game.public).includes('endurance'));for(let i=1;i<5;i++){await call(i,'get');assert.equal(response.game.private.endurance,null);}
  g.phase='night';g.phaseId++;g.day++;g.selections={};g.confirmed=[];await save(g);await night({'1':ids[0],'2':ids[4],'3':'__no_injection__'});g=await state();assert.equal(g.players[0].alive,false);assert.equal(g.victimId,ids[0]);assert.equal(g.enduranceUsed[ids[0]],3);
 });
 await t.test('護衛・初回注射は耐久を温存し通常の貢献点を付ける',async()=>{
  await setup();await night({'1':ids[0],'2':ids[0],'3':'__no_injection__'});let g=await state();assert.equal(g.enduranceUsed,undefined);assert.equal(g.scoring.stats[ids[2]].contribution,1);await call(0,'get');assert.deepEqual(response.game.private.endurance,{used:false,day:null});
  await setup();await night({'1':ids[0],'2':ids[4],'3':ids[0]});g=await state();assert.equal(g.enduranceUsed,undefined);assert.equal(g.scoring.stats[ids[3]].contribution,1);
  await setup(undefined,{[ids[0]]:1});await night({'1':ids[0],'2':ids[0],'3':'__no_injection__'});g=await state();assert.equal(g.players[0].alive,true);assert.equal(g.enduranceUsed[ids[0]],1);
 });
 await t.test('2回目の注射・発砲・処刑・途中退場では耐えず、偽の役職にも能力はない',async()=>{
  let g=await setup();g.injectionCounts={[ids[0]]:1};await save(g);await night({'1':ids[0],'2':ids[0],'3':ids[0]});g=await state();assert.equal(g.players[0].alive,false);assert.equal(g.enduranceUsed,undefined);assert.ok(g.nightDeaths.some((d:any)=>d.playerId===ids[0]&&d.cause==='injection'));
  g=await setup();g.phase='hunter';g.hunterPending={actorId:ids[2],resume:'execution',day:3};g.players[2].role='hunter';g.players[2].alive=false;await save(g);await call(2,'select',{targetId:ids[0]});await call(2,'confirm');assert.equal((await state()).players[0].alive,false);
  g=await setup();g.phase='vote';await save(g);for(let i=0;i<5;i++){await call(i,'select',{targetId:ids[i===0?4:0]});await call(i,'confirm');}assert.equal((await state()).players[0].alive,false);
  await setup();await call(0,'remove',{targetId:ids[0]});assert.equal((await state()).players[0].alive,false);
  g=await setup(['villager','wolf','knight','doctor','villager']);g.players[0].initialRole='bodybuilder';g.players[0].apparentRole='bodybuilder';g.players[0].decoy=true;await save(g);await call(0,'get');assert.deepEqual(response.game.private.endurance,{used:false,day:null});await night({'1':ids[0],'2':ids[4],'3':'__no_injection__'});assert.equal((await state()).players[0].alive,false);
 });
 await t.test('怪盗が奪うと能力が移り、元の対象は村人として死亡する',async()=>{
  let g=await setup(['thief','wolf','bodybuilder','knight','villager']);g.phase='roles';await save(g);await call(0,'select',{targetId:ids[2]});for(let i=0;i<5;i++)await call(i,'confirm');g=await state();assert.equal(g.players[0].role,'bodybuilder');assert.equal(g.players[2].role,'villager');await call(2,'get');assert.equal(response.game.private.role,'bodybuilder');assert.equal(response.game.private.endurance.used,false);
  g.phase='night';g.phaseId++;g.selections={};g.confirmed=[];await save(g);await night({'1':ids[0],'3':ids[4]});g=await state();assert.equal(g.players[0].alive,true);assert.equal(g.enduranceUsed[ids[0]],3);
  g.phase='night';g.phaseId++;g.selections={};g.confirmed=[];await save(g);await night({'1':ids[2],'3':ids[4]});g=await state();assert.equal(g.players[2].alive,false);
 });
 await t.test('旧操作口を拒否、再戦で耐久をリセットし、役職数上限も検証する',async()=>{
  await user(0);await assert.rejects(()=>raw('game_command_doctor','get',{roomId}),/permission denied/);await assert.rejects(()=>db.query('select state from app_private.games'),/permission denied/);
  const g=await state();g.phase='finished';g.winner='village';await save(g);await call(0,'rematch');await user(0);
  await assert.rejects(()=>raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,compositionMode:'custom',composition:{villager:2,wolf:1,seer:0,medium:0,knight:0,madman:0,lover:0,baker:0,thief:0,hunter:0,doctor:0,bodybuilder:2},discussionMinutes:3}),/0〜1/);
  response=await raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId:randomUUID()});assert.equal((await state()).enduranceUsed,undefined);
 });
 }finally{await db.close();}
});
