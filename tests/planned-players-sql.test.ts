import { cleanLobbyComposition } from '../src/web/lobby-settings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
test('予定人数：1人で保存、参加増減で維持、人数違いの開始拒否、明示調整・再送・再適用',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;
 create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 const users=Array.from({length:11},()=>randomUUID());for(const u of users)await db.query('insert into auth.users values($1)',[u]);
 const user=async(i:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users[i]!]);await db.exec('set role authenticated');};
 const raw=async(fn:string,action:string,payload:object)=>(await db.query<{data:any}>(`select public.${fn}($1,$2::jsonb)data`,[action,JSON.stringify(payload)])).rows[0]!.data;
 await user(0);let response=await raw('lobby_command_bodybuilder','create',{nickname:'主催',requestId:randomUUID()});const roomId=response.room.id,code=response.room.code;
 const comp={villager:4,wolf:2,seer:1,medium:1,knight:1,madman:1,lover:0,baker:0,thief:0,hunter:0,doctor:0,bodybuilder:0};
 const settings=(extra:object={})=>raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,plannedPlayers:10,compositionMode:'custom',composition:comp,discussionMinutes:7,consecutiveGuard:false,wolfboundEnabled:true,...extra});
 try{
 assert.equal(response.room.plannedPlayers,null);
 for(const invalid of [4,14,6.5,'10',{},true])await assert.rejects(()=>settings({plannedPlayers:invalid}),/予定人数/);
 response=await settings();assert.equal(response.room.plannedPlayers,10);assert.deepEqual(response.room.composition,comp);assert.equal(response.room.members.length,1);
 for(let i=1;i<7;i++){await user(i);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'参加'+i});}
 assert.equal(response.room.members.length,7);assert.deepEqual(response.room.composition,comp);assert.equal(response.room.discussionMinutes,7);
 await user(1);await assert.rejects(()=>settings(),/主催者/);
 await user(0);await assert.rejects(()=>raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId:randomUUID()}),/人数/);
 // Standard and random start paths must also enforce the planned roster, even via existing RPCs.
 for(const mode of ['standard','random']){
  response=await settings({compositionMode:mode,composition:null,randomCandidates:[]});
  assert.equal(response.room.plannedPlayers,10);
  if(mode==='standard')assert.equal(response.room.composition.wolf,2);else assert.equal(response.room.composition,null);
  await assert.rejects(()=>raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId:randomUUID()}),/予定人数/);
 }
 response=await settings();
 // A leave must preserve the ten-player custom setup.
 const leaving=response.room.members.find((m:any)=>m.nickname==='参加6');await user(6);await raw('membership_command','leave',{roomId,memberId:leaving.id,revision:response.room.revision});
 await user(0);response=await raw('lobby_command_bodybuilder','get',{roomId});assert.deepEqual(response.room.composition,comp);assert.equal(response.room.members.length,6);
 await user(6);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'参加6'});
 for(let i=7;i<=10;i++){await user(i);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'参加'+i});}
 assert.equal(response.room.members.length,11);assert.deepEqual(response.room.composition,comp);
 await user(0);await assert.rejects(()=>raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId:randomUUID()}),/人数/);
 // Explicit adaptation to eleven players preserves all non-villager roles.
 response=await settings({plannedPlayers:11,composition:{...comp,villager:5}});assert.equal(response.room.composition.seer,1);
 response=await settings({plannedPlayers:null,compositionMode:'standard',composition:null});assert.equal(response.room.plannedPlayers,null);
 response=await settings({plannedPlayers:11,composition:{...comp,villager:5}});
 const requestId=randomUUID();response=await raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId});assert.equal(response.game.public.players.length,11);
 const gameId=response.game.public.id;response=await raw('game_command_bodybuilder','start',{roomId,revision:response.room.revision,requestId});assert.equal(response.game.public.id,gameId);
 // Reapply safely, preserving a running game and planned settings.
 await db.exec('reset role');await db.exec(await readFile(new URL('202610220027_planned_players.sql',dir),'utf8'));
 await user(0);response=await raw('game_command_bodybuilder','get',{roomId});assert.equal(response.room.plannedPlayers,11);assert.equal(response.game.public.id,gameId);
 }finally{await db.close();}
});
