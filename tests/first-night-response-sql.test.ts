import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('初夜SQL: パンなしで最後の確認後も応答が空にならず、全端末で昼に復帰する',async t=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 const users=Array.from({length:13},()=>randomUUID());for(const id of users)await db.query('insert into auth.users values($1)',[id]);
 const user=async(i:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users[i]!]);await db.exec('set role authenticated');};
 const raw=async(fn:string,action:string,payload:object)=>(await db.query<{r:any}>(`select public.${fn}($1,$2::jsonb) r`,[action,JSON.stringify(payload)])).rows[0]!.r;
 for(const n of [5,8,13])await t.test(`${n}人・パン屋なし、最後の確認と再送・全員の再取得`,async()=>{
  await user(0);let r=await raw('lobby_command_bodybuilder','create',{nickname:'主催'+n,requestId:randomUUID()});const roomId=r.room.id;
  for(let i=1;i<n;i++){await user(i);r=await raw('lobby_command_bodybuilder','join',{code:r.room.code,nickname:'参加'+i});}
  await user(0);r=await raw('game_command_bodybuilder','start',{roomId,revision:r.room.revision,requestId:randomUUID()});
  const gameId=r.game.public.id;let phaseId=r.game.public.phaseId;
  for(let i=0;i<n;i++){await user(i);r=await raw('game_command_bodybuilder','confirm',{roomId,gameId,phaseId,requestId:randomUUID()});assert.equal(r.ok,true);}
  assert.equal(r.game.public.phase,'firstNight');phaseId=r.game.public.phaseId;const requestId=randomUUID();
  for(let i=0;i<n;i++){await user(i);r=await raw('game_command_bodybuilder','confirm',{roomId,gameId,phaseId,requestId:i===n-1?requestId:randomUUID()});assert.ok(r);assert.equal(r.ok,true);if(i<n-1)assert.equal(r.game.public.phase,'firstNight');}
  assert.equal(r.game.public.phase,'discussion');assert.equal(r.game.public.day,1);assert.equal(r.game.public.breadDelivered,false);assert.equal(r.game.public.breadDelivery,null);
  const discussionPhase=r.game.public.phaseId,deadline=r.game.public.deadline;
  r=await raw('game_command_bodybuilder','confirm',{roomId,gameId,phaseId,requestId});assert.equal(r.game.public.phaseId,discussionPhase);assert.equal(r.game.public.deadline,deadline);
  for(let i=0;i<n;i++){await user(i);r=await raw('game_command_bodybuilder','get',{roomId});assert.equal(r.ok,true);assert.equal(r.game.public.phaseId,discussionPhase);assert.equal(r.game.public.breadDelivered,false);}
 });
 await t.test('怪盗が獅子舞を奪い、初夜に二人へ福を配って追加勝利する',async()=>{
  await user(1);
  let r=await raw('lobby_command_bodybuilder','create',{nickname:'獅子舞テスト',requestId:randomUUID()});
  const roomId=r.room.id;
  for(const i of [0,2,3,4]){
   await user(i);r=await raw('lobby_command_bodybuilder','join',{code:r.room.code,nickname:'参加'+i});
  }
  await user(1);
  r=await raw('lobby_command_bodybuilder','settings',{
   roomId,revision:r.room.revision,discussionMinutes:3,compositionMode:'custom',
   composition:{villager:2,wolf:1,seer:0,medium:0,knight:0,thief:1,shishimai:1},
  });
  assert.equal(r.room.shishimaiRole,true);
  r=await raw('game_command_bodybuilder','start',{roomId,revision:r.room.revision,requestId:randomUUID()});
  const gameId=r.game.public.id;
  let phaseId=r.game.public.phaseId;
  const command=(action:string,extra:object={})=>raw('game_command_bodybuilder',action,{roomId,gameId,phaseId,requestId:randomUUID(),...extra});
  const seats=[];
  for(let i=0;i<5;i++){
   await user(i);
   const view=await raw('game_command_bodybuilder','get',{roomId});
   seats.push({i,id:view.room.viewerId,role:view.game.private.role});
  }
  const thief=seats.find(s=>s.role==='thief')!, decoy=seats.find(s=>s.role==='shishimai')!;
  const wolf=seats.find(s=>s.role==='wolf')!, villagers=seats.filter(s=>s.role==='villager');
  await user(thief.i);await command('select',{targetId:decoy.id});
  for(const s of seats){await user(s.i);r=await command('confirm');}
  assert.equal(r.game.public.phase,'firstNight');
  phaseId=r.game.public.phaseId;
  await user(thief.i);
  await assert.rejects(()=>command('confirm'),/福を配る対象が不正/);
  await assert.rejects(()=>command('select',{targetId:JSON.stringify([thief.id])}),/福を配る対象が不正/);
  await assert.rejects(()=>command('select',{targetId:JSON.stringify([wolf.id,wolf.id])}),/福を配る対象が不正/);
  const targets=villagers.map(s=>s.id);
  await command('select',{targetId:JSON.stringify(targets)});
  await user(decoy.i);await command('select',{targetId:JSON.stringify([thief.id])});
  for(const s of seats){await user(s.i);r=await command('confirm');}
  assert.equal(r.game.public.phase,'discussion');
  assert.equal(r.game.public.shishimaiWinnerId,undefined);
  for(const s of seats){
   await user(s.i);r=await raw('game_command_bodybuilder','get',{roomId});
   assert.equal(r.game.private.blessingReceived,targets.includes(s.id));
   if(s===thief) assert.deepEqual(r.game.private.blessing,{deliveredIds:targets,doubleUsed:true});
   else if(s===decoy) assert.deepEqual(r.game.private.blessing,{deliveredIds:[thief.id],doubleUsed:false});
   else assert.equal(r.game.private.blessing,undefined);
  }
  await user(1);phaseId=r.game.public.phaseId;
  r=await command('remove',{targetId:decoy.id});phaseId=r.game.public.phaseId;
  r=await command('remove',{targetId:wolf.id});
  assert.equal(r.game.public.phase,'finished');
  assert.equal(r.game.public.winner,'village');
  assert.equal(r.game.public.shishimaiWinnerId,thief.id);
  assert.deepEqual(r.game.public.scores.find((s:any)=>s.playerId===thief.id),{playerId:thief.id,victory:5,survival:0,contribution:0,total:5});
 });
 await db.exec('reset role');
 await t.test('パンあり・なし・旧データの未設定値・初夜・通常朝の表示を保持',async()=>{
  const roomId=(await db.query<{room_id:string}>('select room_id from app_private.games limit 1')).rows[0]!.room_id;
  const original=(await db.query<{state:any}>('select state from app_private.games where room_id=$1',[roomId])).rows[0]!.state;
  const base={ok:true,room:{id:roomId},game:{public:{}}};
  for(const phase of ['firstNight','discussion','morning','finished'])for(const delivery of [undefined,null,{day:0,breadType:'croissant'}]){
   const g={...original,phase,day:phase==='morning'?2:1,breadDelivery:delivery};if(delivery===undefined)delete g.breadDelivery;
   await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),roomId]);
   const r=(await db.query<{r:any}>('select app_private.bread_choice_response($1::jsonb,$2) r',[JSON.stringify(base),roomId])).rows[0]!.r;
   assert.equal(r.ok,true);assert.equal(r.game.public.breadDelivered,!!delivery&&['discussion','morning'].includes(phase));
  }
  await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(original),roomId]);
  await db.exec(await readFile(new URL('202610310029_first_night_response_fix.sql',dir),'utf8'));
  assert.deepEqual((await db.query<{state:any}>('select state from app_private.games where room_id=$1',[roomId])).rows[0]!.state,original);
  await db.exec('set role authenticated');await assert.rejects(()=>db.query('select app_private.bread_choice_response($1::jsonb,$2)',[JSON.stringify(base),roomId]),/permission denied/);await db.exec('reset role');
 });
 }finally{await db.close();}
});
