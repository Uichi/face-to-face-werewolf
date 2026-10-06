import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomCombinations, RANDOM_ROLES } from '../src/domain/random-composition.ts';

test('医者SQL：累計注射・複数死亡・怪盗・狩人・秘密・得点',async t=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;
 create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 await db.exec(await readFile(new URL('202610060024_doctor.sql',dir),'utf8'));
 const users=Array.from({length:6},()=>randomUUID());for(const u of users)await db.query('insert into auth.users values($1)',[u]);
 const user=async(i:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users[i]!]);await db.exec('set role authenticated');};
 const raw=async(fn:string,action:string,payload:object)=>(await db.query<{data:any}>(`select public.${fn}($1,$2::jsonb)data`,[action,JSON.stringify(payload)])).rows[0]!.data;
 await user(0);let response=await raw('lobby_command_doctor','create',{nickname:'主催',requestId:randomUUID()});
 for(let i=1;i<5;i++){await user(i);response=await raw('lobby_command_doctor','join',{code:response.room.code,nickname:'参加'+i});}
 const roomId=response.room.id;const ids=response.room.members.map((m:any)=>m.id);
 const state=async()=>{await db.exec('reset role');return(await db.query<{state:any}>('select state from app_private.games where room_id=$1',[roomId])).rows[0]!.state;};
 const save=async(g:any)=>{await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),roomId]);await db.query("update app_private.rooms set status='playing' where id=$1",[roomId]);};
 const call=async(i:number,action:string,extra:object={},requestId=randomUUID())=>{const g=await state();await user(i);return response=await raw('game_command_doctor',action,{roomId,gameId:g.id,phaseId:g.phaseId,requestId,...extra});};
 try{
 await user(0);response=await raw('game_command_doctor','start',{roomId,revision:response.room.revision,requestId:randomUUID()});const original=await state();
 const setup=async(roles:string[],counts:object={})=>{const g=structuredClone(original);g.id=randomUUID();g.phase='night';g.phaseId=20;g.day=4;g.deadline=Date.now()+60000;g.players=roles.map((role,i)=>({id:ids[i],role,initialRole:role,apparentRole:role,alive:true}));g.injectionCounts=counts;g.injectionHistory=[];g.confirmed=[];g.selections={};g.publicLog=[];g.scoring.stats={};await save(g);return g;};
 const night=async(choices:Record<string,string>)=>{const g=await state();for(let i=0;i<5;i++){if(choices[i]!==undefined)await call(i,'select',{targetId:choices[i],strength:2});await call(i,'confirm');}};
 await t.test('自己注射と注射なし、襲撃防止と私人履歴、再送で累計が増えない',async()=>{
  await setup(['doctor','wolf','doctor','villager','villager']);await call(0,'select',{targetId:ids[0]});await call(0,'select',{targetId:'__no_injection__'});
  await night({'0':ids[3],'1':ids[3],'2':'__no_injection__'});let g=await state();assert.equal(g.victimId,null);assert.equal(g.injectionCounts[ids[3]],1);assert.equal(g.scoring.stats[ids[0]].contribution,1);
  assert.equal(g.phase,'morning');await call(0,'get');assert.equal(response.game.private.injectionHistory.length,1);assert.ok(!JSON.stringify(response.game).includes('injectionCounts'));await call(3,'get');assert.deepEqual(response.game.private.injectionHistory,[]);
  g.phase='night';g.phaseId++;g.confirmed=[];g.selections={};await save(g);await night({'0':'__no_injection__','1':ids[4],'2':'__no_injection__'});g=await state();assert.equal(g.injectionCounts[ids[3]],1);assert.equal(g.players[4].alive,false);
 });
 await t.test('別の医者・数日後の2回目も死亡し、複数死亡と護衛を処理する',async()=>{
  await setup(['doctor','wolf','doctor','knight','villager'],{[ids[4]]:1});await night({'0':'__no_injection__','1':ids[0],'2':ids[4],'3':ids[4]});const g=await state();assert.equal(g.players[0].alive,false);assert.equal(g.players[4].alive,false);assert.equal(g.injectionCounts[ids[4]],2);assert.equal(g.nightDeaths.length,2);assert.equal(g.publicLog.filter((e:any)=>e.kind==='injection').length,1);assert.equal(g.scoring.stats[ids[2]]?.contribution??0,0);assert.equal(g.scoring.stats[ids[3]]?.contribution??0,0);
 });
 await t.test('同夜2回で狩人が発動し、発砲後に生存点と勝利点を確定する',async()=>{
  await setup(['doctor','wolf','doctor','hunter','villager']);await night({'0':ids[3],'1':ids[4],'2':ids[3]});let g=await state();assert.equal(g.phase,'hunter');assert.equal(g.winner,null);assert.equal(g.injectionCounts[ids[3]],2);assert.equal(g.scoring.stats[ids[0]]?.survival??0,0);
  await call(3,'select',{targetId:ids[1]});const phaseId=(await state()).phaseId;const gameId=(await state()).id;const requestId=randomUUID();await call(3,'confirm',{},requestId);g=await state();assert.equal(g.winner,'village');assert.equal(g.scoring.stats[ids[0]].survival,1);assert.equal(g.scoring.stats[ids[3]].contribution,1);
  await user(3);await raw('game_command_doctor','confirm',{roomId,gameId,phaseId,requestId});assert.deepEqual(await state(),g);
 });
 await t.test('恋人双方の直接死亡と後追いを区別し、死亡した医者の注射も成立する',async()=>{
  await setup(['doctor','wolf','doctor','lover','lover'],{[ids[3]]:1});await night({'0':ids[3],'1':ids[4],'2':'__no_injection__'});let g=await state();assert.equal(g.nightDeaths.length,2);assert.ok(g.nightDeaths.every((d:any)=>d.followedIds.length===0));
  await setup(['doctor','wolf','doctor','lover','lover'],{[ids[3]]:1});await night({'0':ids[3],'1':ids[0],'2':'__no_injection__'});g=await state();assert.equal(g.players[0].alive,false);assert.equal(g.players[3].alive,false);assert.equal(g.players[4].alive,false);assert.deepEqual(g.nightDeaths.find((d:any)=>d.playerId===ids[3]).followedIds,[ids[4]]);
 });
 await t.test('医者と騎士両方に貢献点、偽の注射は累計にも結果にも影響しない',async()=>{
  await setup(['doctor','wolf','doctor','knight','villager']);await night({'0':ids[4],'1':ids[4],'2':'__no_injection__','3':ids[4]});let g=await state();assert.equal(g.scoring.stats[ids[0]].contribution,1);assert.equal(g.scoring.stats[ids[3]].contribution,1);
  g=await setup(['villager','wolf','doctor','villager','villager']);g.players[0].decoy=true;g.players[0].apparentRole='doctor';g.players[0].initialRole='doctor';await save(g);await night({'0':ids[4],'1':ids[4],'2':'__no_injection__'});g=await state();assert.equal(g.players[4].alive,false);assert.equal(g.injectionCounts[ids[4]],undefined);
 });
 await t.test('怪盗が医者を取得し、元の医者には偽表示を保ちながら実能力を移す',async()=>{
  let g=await setup(['thief','wolf','doctor','villager','villager']);g.phase='roles';g.injectionCounts={[ids[0]]:1};await save(g);
  await call(0,'select',{targetId:ids[2]});for(let i=0;i<5;i++)await call(i,'confirm');g=await state();assert.equal(g.players[0].role,'doctor');assert.equal(g.players[2].role,'villager');assert.equal(g.injectionCounts[ids[0]],1);await call(2,'get');assert.equal(response.game.private.role,'doctor');
  g.phase='night';g.phaseId++;g.confirmed=[];g.selections={};await save(g);await night({'0':ids[4],'1':ids[4],'2':ids[4]});g=await state();assert.equal(g.injectionCounts[ids[4]],1);assert.equal(g.players[4].alive,true);
 });
 await t.test('旧操作口と秘密の累計取得を拒否、再戦で累計を破棄する',async()=>{
  await user(0);await assert.rejects(()=>raw('game_command_random','get',{roomId}),/permission denied/);await assert.rejects(()=>db.query('select state from app_private.games'),/permission denied/);
  let g=await state();g.phase='finished';g.winner='village';await save(g);await call(0,'rematch');await user(0);response=await raw('game_command_doctor','start',{roomId,revision:response.room.revision,requestId:randomUUID()});g=await state();assert.equal(g.injectionCounts,undefined);assert.equal(g.injectionHistory,undefined);
 });
 }finally{await db.close();}
});
