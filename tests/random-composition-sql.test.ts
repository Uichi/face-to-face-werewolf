import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { randomCombinations, RANDOM_ROLES } from '../src/domain/random-composition.ts';

test('ランダム配役SQL：抽選・秘密・互換・再送・再戦・権限',async t=>{
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
 const call=async(i:number,action:string,extra:object={},requestId=randomUUID())=>{const g=await state();await user(i);return response=await raw('game_command_doctor',action,{roomId,gameId:g.id,phaseId:g.phaseId,requestId,...extra});};
 try{
 await t.test('全人数でSQLとルールの候補順が一致し恋人と役職上限を守る',async()=>{
  await db.exec('reset role');
  for(let n=5;n<=13;n++){
   const choices=randomCombinations(n,RANDOM_ROLES);
   for(const i of [0,Math.floor(choices.length/2),choices.length-1]){
    await db.exec(`create or replace function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(case when n=4 then '${i.toString(16).padStart(8,'0')}'else repeat('00',n)end,'hex')$$`);
    const comp=(await db.query<{comp:any}>('select app_private.random_composition($1,$2::jsonb)comp',[n,JSON.stringify(RANDOM_ROLES)])).rows[0]!.comp;
    assert.deepEqual(comp,choices[i]);
   }
  }
  await db.exec(`create or replace function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$`);
  await assert.rejects(()=>db.query("select app_private.random_composition(5,'[\"wolf\"]')"),/候補/);
 });
 await t.test('候補なしで開始し全端末に人数を返さず二重開始で再抽選しない',async()=>{
  await user(0);response=await raw('lobby_command_doctor','get',{roomId});
  response=await raw('lobby_command_doctor','settings',{roomId,revision:response.room.revision,compositionMode:'random',randomCandidates:[],composition:null,discussionMinutes:3,wolfboundEnabled:true});
  assert.equal(response.room.composition,null);assert.equal(response.room.randomComposition,true);
  const requestId=randomUUID();response=await raw('game_command_doctor','start',{roomId,revision:response.room.revision,requestId});
  const g=await state();assert.equal(g.initialComposition.villager,4);assert.equal(g.initialComposition.wolf,1);
  await user(0);response=await raw('game_command_doctor','start',{roomId,requestId});assert.equal(response.game.public.composition,null);assert.deepEqual(await state(),g);
  for(let i=0;i<5;i++){await call(i,'get');assert.equal(response.room.composition,null);assert.equal(response.game.public.composition,null);assert.equal(response.game.public.fixedWolves,1);assert.ok(response.game.public.players.every((p:any)=>!('initialRole'in p)));}
  await user(5);await assert.rejects(()=>raw('game_command_doctor','get',{roomId}),/参加/);
  await user(0);await assert.rejects(()=>raw('game_command_hunter','get',{roomId}),/permission denied/);await assert.rejects(()=>raw('lobby_command_hunter','settings',{roomId}),/permission denied/);
 });
 await t.test('途中退場・勝敗・再戦後も候補維持、終了後のみ開始時配役を公開',async()=>{
  const g=await state();const wolf=g.players.find((p:any)=>p.role==='wolf');
  await call(0,'remove',{targetId:wolf.id});assert.equal(response.game.public.phase,'finished');assert.deepEqual(response.game.public.composition,g.initialComposition);assert.ok(response.game.public.players.every((p:any)=>p.role));
  await call(0,'rematch');assert.equal(response.room.compositionMode,'random');assert.deepEqual(response.room.randomCandidates,[]);assert.equal(response.room.composition,null);
  await user(0);response=await raw('game_command_doctor','start',{roomId,revision:response.room.revision,requestId:randomUUID()});assert.notEqual(response.game.public.id,g.id);assert.equal(response.game.public.composition,null);
 });
 }finally{await db.close();}
});
