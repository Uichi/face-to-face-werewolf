import { cleanLobbyComposition } from '../src/web/lobby-settings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
test('参加・再参加・削除・退出で配役とルールを保持し、明示的なモード変更は許可する',async()=>{
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
 assert.equal(cleanLobbyComposition(response.room.composition),null);
 for(let i=1;i<5;i++){await user(i);response=await raw('lobby_command_bodybuilder','join',{code:response.room.code,nickname:'参加'+i});}
 const roomId=response.room.id;
 try {
 await user(0);response=await raw('lobby_command_bodybuilder','get',{roomId});
 const comp={villager:3,wolf:1,seer:1,medium:0,knight:0,madman:0,lover:0,baker:0,thief:0,hunter:0,doctor:0,bodybuilder:0};
 response=await raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,compositionMode:'custom',composition:comp,discussionMinutes:7,consecutiveGuard:false,wolfboundEnabled:true,randomCandidates:['seer','doctor'],victoryPoints:{...response.room.victoryPoints,wolf:9}});
 const code=response.room.code;
 await user(5);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'追加'});
 assert.equal(response.room.customComposition,true);assert.equal(response.room.composition.villager,4);assert.equal(response.room.composition.seer,1);assert.equal(response.room.discussionMinutes,7);assert.equal(response.room.consecutiveGuard,false);assert.equal(response.room.victoryPoints.wolf,9);assert.deepEqual(response.room.randomCandidates,['seer','doctor']);
 const member=response.room.members.find((m:any)=>m.nickname==='追加');
 response=await raw('lobby_command_bodybuilder','join',{code,nickname:'追加'});assert.equal(response.room.composition.villager,4);
 await user(0);response=await raw('membership_command','remove',{roomId,memberId:response.room.hostId,targetId:member.id,revision:response.room.revision});
 response=await raw('lobby_command_bodybuilder','get',{roomId});assert.equal(response.room.composition.villager,3);assert.equal(response.room.customComposition,true);assert.equal(response.room.discussionMinutes,7);
 await user(5);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'再参加'});
 const me=response.room.members.find((m:any)=>m.nickname==='再参加');
 await raw('membership_command','leave',{roomId,memberId:me.id,revision:response.room.revision});
 await user(0);response=await raw('lobby_command_bodybuilder','get',{roomId});assert.equal(response.room.composition.villager,3);
 response=await raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,compositionMode:'random',randomCandidates:['doctor'],discussionMinutes:7});
 await user(5);response=await raw('lobby_command_bodybuilder','join',{code,nickname:'再追加'});assert.equal(response.room.composition,null);assert.equal(response.room.compositionMode,'random');assert.deepEqual(response.room.randomCandidates,['doctor']);
 await user(0);response=await raw('lobby_command_bodybuilder','get',{roomId});
 response=await raw('lobby_command_bodybuilder','settings',{roomId,revision:response.room.revision,compositionMode:'standard',discussionMinutes:7});assert.equal(response.room.customComposition,false);assert.equal(response.room.compositionMode,'standard');
 await db.exec('reset role');await db.exec(await readFile(new URL('202610220026_lobby_settings.sql',dir),'utf8'));
 } finally {await db.close();}
});
