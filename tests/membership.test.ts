import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Room } from '../src/web/types.ts';

test('参加者整理: 権限・再参加・再送・主催者退出・試合中拒否', async t => {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of ['202609250001_lobby.sql','202609270003_game.sql','202609270004_membership.sql','202609270004_membership.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 async function user(id:string|null){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec('set role authenticated');}
 async function rpc(fn:string,action:string,payload:Record<string,unknown>){return (await db.query<{data:{ok:boolean;code?:string;room:Room;left?:boolean;game?:any}}>(`select public.${fn}($1,$2::jsonb) data`,[action,JSON.stringify(payload)])).rows[0]!.data;}
 async function setup(){
  const ids=Array.from({length:6},()=>randomUUID()),createId=randomUUID();
  await db.exec('reset role');for(const id of ids)await db.query('insert into auth.users values($1)',[id]);
  await user(ids[0]!);let room=(await rpc('lobby_command','create',{nickname:'P0',requestId:createId})).room;
  for(let i=1;i<5;i++){await user(ids[i]!);room=(await rpc('lobby_command','join',{nickname:'P'+i,code:room.code})).room;}
  const seats=room.members.map(m=>m.id);
  async function call(i:number,action:string,extra:Record<string,unknown>={}){
   await user(ids[i]!);const out=await rpc('membership_command',action,{roomId:room.id,memberId:seats[i],revision:room.revision,...extra});if(out.room)room=out.room;return out;
  }
  return{ids,seats,createId,call,get room(){return room;}};
 }
 try{
  await t.test('主催者だけが他人を削除でき、対象端末のアクセスを失効する',async()=>{
   const f=await setup();
   await user(null);await assert.rejects(rpc('membership_command','leave',{roomId:f.room.id}));
   await assert.rejects(f.call(1,'remove',{targetId:f.seats[2]}));
   await assert.rejects(f.call(5,'remove',{targetId:f.seats[2]}));
   await assert.rejects(f.call(0,'remove',{targetId:f.seats[0]}));
   await assert.rejects(f.call(0,'remove',{targetId:f.seats[2],revision:0}));
   await user(f.ids[0]!);const before=(await rpc('lobby_command','settings',{roomId:f.room.id,revision:f.room.revision,discussionMinutes:4,composition:{villager:2,wolf:1,seer:1,medium:1,knight:0}})).room;
   const removed=await f.call(0,'remove',{targetId:f.seats[1],revision:before.revision});
   assert.equal(removed.room.members.length,4);assert.equal(removed.room.customComposition,false);assert.equal(removed.room.composition,null);assert.equal(removed.room.discussionMinutes,4);
   const revision=removed.room.revision;await f.call(0,'remove',{targetId:f.seats[1]});assert.equal(f.room.revision,revision);
   await user(f.ids[1]!);const denied=await rpc('lobby_command','heartbeat',{roomId:f.room.id});assert.equal(denied.code,'ROOM_ACCESS_LOST');
   const updates=await db.query('select * from public.room_updates where room_id=$1',[f.room.id]);assert.equal(updates.rows.length,0);
   await assert.rejects(rpc('game_command','get',{roomId:f.room.id}));
   const rejoined=(await rpc('lobby_command','join',{code:f.room.code,nickname:'P1'})).room;assert.notEqual(rejoined.viewerId,f.seats[1]);
   await f.call(0,'remove',{targetId:f.seats[1]});assert.equal(f.room.members.length,5);
  });
  await t.test('自分だけ退出でき、再参加後に古い退出を再送しても新しい席を消さない',async()=>{
   const f=await setup();await assert.rejects(f.call(1,'leave',{memberId:f.seats[2]}));
   assert.equal((await f.call(1,'leave')).left,true);assert.equal((await f.call(1,'leave')).left,true);
   await user(f.ids[1]!);const joined=(await rpc('lobby_command','join',{code:f.room.code,nickname:'P1'})).room;
   await assert.rejects(f.call(1,'leave',{revision:joined.revision}));
   const found=(await rpc('lobby_command','get',{roomId:f.room.id})).room;assert.equal(found.viewerId,joined.viewerId);
  });
  await t.test('主催者退出で権限移行し、作成者の古い作成要求にも情報を返さず、全員退出で部屋を消す',async()=>{
   const f=await setup();assert.equal((await f.call(0,'leave')).left,true);
   await user(f.ids[1]!);let room=(await rpc('lobby_command','get',{roomId:f.room.id})).room;assert.equal(room.hostId,f.seats[1]);
   await user(f.ids[0]!);const retry=await rpc('lobby_command','create',{nickname:'P0',requestId:f.createId});assert.equal(retry.code,'ROOM_ACCESS_LOST');assert.equal(retry.room,undefined);
   for(let i=1;i<5;i++){
    await user(f.ids[i]!);room=(await rpc('lobby_command','get',{roomId:room.id})).room;
    assert.equal((await rpc('membership_command','leave',{roomId:room.id,memberId:f.seats[i],revision:room.revision})).left,true);
   }
   await db.exec('reset role');assert.equal((await db.query('select id from app_private.rooms where id=$1',[room.id])).rows.length,0);
   assert.equal((await db.query('select room_id from public.room_updates where room_id=$1',[room.id])).rows.length,0);
  });
  await t.test('開始済みの試合では席を削除せず、再戦後の待機室で削除できる',async()=>{
   const f=await setup();await user(f.ids[0]!);let result=await rpc('game_command','start',{roomId:f.room.id,revision:f.room.revision,requestId:randomUUID()});
   await assert.rejects(f.call(0,'remove',{targetId:f.seats[1]}));await assert.rejects(f.call(1,'leave'));
   await db.exec('reset role');const state=(await db.query<{state:any}>('select state from app_private.games where room_id=$1',[f.room.id])).rows[0]!.state;
   await user(f.ids[0]!);result=await rpc('game_command','remove',{roomId:f.room.id,gameId:state.id,phaseId:state.phaseId,requestId:randomUUID(),targetId:state.players.find((p:any)=>p.role==='wolf').id});
   await assert.rejects(f.call(1,'leave'));
   await user(f.ids[0]!);result=await rpc('game_command','rematch',{roomId:f.room.id,gameId:state.id,phaseId:result.game.public.phaseId,requestId:randomUUID()});
   const removed=await f.call(0,'remove',{targetId:f.seats[1],revision:result.room.revision});assert.equal(removed.room.members.length,4);
  });
 }finally{await db.close();}
});
