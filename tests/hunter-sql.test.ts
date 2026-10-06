import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createGame } from '../src/domain/game.ts';
import type { Game } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';

test('狩人SQL: 新規配役・死亡後発砲・夜の確定・得点・権限・互換性',async t=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid()to authenticated;
 create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat(lpad(to_hex(floor(random()*256)::integer),2,'0'),n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 await db.exec(await readFile(new URL('202610060023_random_composition.sql',dir),'utf8'));
 const users=Array.from({length:5},()=>randomUUID());for(const u of users)await db.query('insert into auth.users values($1)',[u]);
 const user=async(i:number)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[users[i]!]);await db.exec('set role authenticated');};
 const raw=async(fn:string,action:string,payload:object)=>(await db.query<{data:any}>(`select public.${fn}($1,$2::jsonb)data`,[action,JSON.stringify(payload)])).rows[0]!.data;
 await user(0);let response=await raw('lobby_command_random','create',{nickname:'主催',requestId:randomUUID()});
 for(let i=1;i<5;i++){await user(i);response=await raw('lobby_command_random','join',{code:response.room.code,nickname:'参加'+i});}
 const roomId=response.room.id;const ids=response.room.members.map((m:any)=>m.id) as string[];
 const state=async()=>{await db.exec('reset role');return(await db.query<{state:Game}>('select state from app_private.games where room_id=$1',[roomId])).rows[0]!.state;};
 const save=async(g:Game)=>{await db.exec('reset role');await db.query("insert into app_private.games(room_id,state)values($1,$2::jsonb)on conflict(room_id)do update set state=excluded.state",[roomId,JSON.stringify(g)]);await db.query("update app_private.rooms set status='playing'where id=$1",[roomId]);};
 const call=async(i:number,action:string,extra:object={},requestId=randomUUID())=>{const g=await state();await user(i);return response=await raw('game_command_random',action,{roomId,gameId:g.id,phaseId:g.phaseId,requestId,...extra});};
 const base=(roles:string[])=>{const g=createGame({id:randomUUID(),hostId:ids[0]!,playerIds:ids,composition:DEFAULT_COMPOSITIONS[5]!},0,()=>0);g.players=roles.map((role,i)=>({id:ids[i]!,role:role as any,initialRole:role as any,apparentRole:role as any,alive:true}));g.phase='vote';g.phaseId=12;g.deadline=Date.now()+60000;return g;};
 const execute=async()=>{for(let i=0;i<5;i++){await call(i,'select',{targetId:ids[i===0?1:0]});await call(i,'confirm');}};
 try{
 await t.test('10役職配役と勝利点を保存して開始、旧操作口は禁止',async()=>{
  await user(0);response=await raw('lobby_command_random','settings',{roomId,revision:response.room.revision,composition:{...DEFAULT_COMPOSITIONS[5],villager:2,hunter:1},discussionMinutes:3});assert.equal(response.room.composition.hunter,1);assert.equal(response.room.victoryPoints.hunter,5);
  const startId=randomUUID();response=await raw('game_command_random','start',{roomId,revision:response.room.revision,requestId:startId});assert.equal(response.room.hunterRole,true);assert.equal(response.game.public.composition.hunter,1);assert.equal(response.game.public.resultConfirmation,false);assert.equal(response.game.public.players.some((p:any)=>'role'in p),false);
  const before=await state();await user(0);await raw('game_command_random','start',{roomId,requestId:startId});assert.deepEqual(await state(),before);
  await user(0);await assert.rejects(()=>raw('game_command_wolfbound','get',{roomId}),/permission denied/);
 });
 await t.test('処刑後は勝敗を保留し本人のみ発砲、再送でも累計が増えない',async()=>{
  await save(base(['hunter','wolf','villager','villager','villager']));await execute();let g=await state();assert.equal(g.phase,'hunter');assert.equal(g.winner,null);assert.equal(g.scores,undefined);
  response=await call(0,'get');assert.equal(response.game.private.role,'hunter');assert.equal(response.game.public.hunter.actorId,ids[0]);assert.equal(response.game.public.players.some((p:any)=>'role'in p),false);
  await assert.rejects(()=>call(1,'select',{targetId:ids[2]}),/狩人本人/);await assert.rejects(()=>call(0,'cancelShot'),/期限後/);
  await call(0,'select',{targetId:ids[2]});await call(0,'select',{targetId:ids[1]});const phaseId=(await state()).phaseId;const req=randomUUID();await call(0,'confirm',{},req);
  g=await state();assert.equal(g.phase,'finished');assert.equal(g.winner,'village');assert.equal(g.scores!.find(s=>s.playerId===ids[0])!.contribution,1);assert.equal(g.lastElimination!.cause,'shot');assert.deepEqual(g.publicLog!.map(e=>e.kind),['execution','hunterReady','shot']);
  const points=response.room.members.map((m:any)=>m.points);await user(0);response=await raw('game_command_random','confirm',{roomId,gameId:g.id,phaseId,requestId:req});assert.deepEqual(response.room.members.map((m:any)=>m.points),points);
  const waiting=await call(0,'rematch');assert.equal(waiting.room.status,'waiting');assert.equal(waiting.room.composition.hunter,1);assert.deepEqual(waiting.room.members.map((m:any)=>m.points),points);
 });
 await t.test('襲撃後の発砲は護衛を無視、パンと生存点は発砲後に確定',async()=>{
  const g=base(['hunter','wolf','baker','knight','seer']);g.phase='night';await save(g);
  await call(1,'select',{targetId:ids[0],strength:2});await call(2,'select',{targetId:'croissant'});await call(3,'select',{targetId:ids[2]});await call(4,'select',{targetId:ids[1]});for(let i=0;i<5;i++)await call(i,'confirm');
  let pending=await state();assert.equal(pending.phase,'hunter');assert.equal(pending.day,1);assert.equal(pending.scoring!.stats[ids[2]!] ?.survival??0,0);
  await call(0,'select',{targetId:ids[2]});await call(0,'confirm');pending=await state();assert.equal(pending.breadDelivery,null);assert.equal(pending.day,2);assert.equal(pending.scoring!.stats[ids[2]!] ?.survival??0,0);assert.equal(pending.scoring!.stats[ids[4]!]!.survival,1);assert.equal(pending.players[2]!.alive,false);
 });
 await t.test('恋人への発砲で後追い、対象退場は選択解除、時間切れ後の中止',async()=>{
  await save(base(['hunter','wolf','lover','lover','villager']));await execute();await call(0,'select',{targetId:ids[2]});await call(0,'confirm');let g=await state();assert.equal(g.players[2]!.alive,false);assert.equal(g.players[3]!.alive,false);assert.deepEqual(g.publicLog!.at(-1)!.followedIds,[ids[3]]);
  await save(base(['hunter','wolf','villager','villager','villager']));await execute();await call(0,'select',{targetId:ids[1]});await call(0,'remove',{targetId:ids[1]});g=await state();assert.equal(g.phase,'hunter');assert.equal(g.winner,null);assert.equal(g.selections[ids[0]!],undefined);
  g.deadline=0;await save(g);await call(0,'get');assert.equal((await state()).phase,'hunter');await call(0,'extend');await assert.rejects(()=>call(0,'cancelShot'),/期限後/);g=await state();g.deadline=0;await save(g);await call(0,'cancelShot');assert.equal((await state()).phase,'finished');assert.equal((await state()).publicLog!.at(-1)!.kind,'shotCancelled');
 });
 await t.test('怪盗に奪われた狩人は村人、本物の狩人のみ能力を持つ',async()=>{
  const g=base(['hunter','thief','wolf','villager','villager']);g.phase='roles';await save(g);await call(1,'select',{targetId:ids[0]});for(let i=0;i<5;i++)await call(i,'confirm');let changed=await state();assert.equal(changed.players[0]!.role,'villager');assert.equal(changed.players[1]!.role,'hunter');response=await call(0,'get');assert.equal(response.game.private.role,'hunter');assert.equal(response.game.public.players.some((p:any)=>'role'in p),false);
  changed.phase='vote';changed.selections={};changed.confirmed=[];await save(changed);await execute();assert.notEqual((await state()).phase,'hunter');
 });
 await t.test('狩人なしの村側勝利と再戦、狼憑きの黒判定が維持される',async()=>{
  const g=base(['villager','wolf','seer','villager','villager']);g.phase='night';g.players[3]!.wolfbound=true;await save(g);await call(1,'select',{targetId:ids[4],strength:2});await call(2,'select',{targetId:ids[3]});for(let i=0;i<5;i++)await call(i,'confirm');const after=await state();assert.equal(after.phase,'morning');assert.equal(after.secrets.find(s=>s.recipientId===ids[2])!.isWolf,true);assert.equal(after.scoring!.stats[ids[2]!]!.contribution,0);response=await call(3,'get');assert.equal(JSON.stringify(response.game).includes('wolfbound'),false);
 });
 await t.test('初日処刑なしは複数人で選択でき、結果は主催者の次へで進む',async()=>{
  await save(base(['hunter','wolf','seer','villager','villager']));
  for(let i=0;i<5;i++)await call(i,'select',{targetId:'__no_execution__'});
  for(let i=0;i<5;i++)await call(i,'confirm');assert.equal((await state()).phase,'execution');
  await call(2,'get');assert.equal((await state()).phase,'execution');await assert.rejects(()=>call(2,'next'),/主催者/);await call(0,'next');assert.equal((await state()).phase,'night');
 });
 await t.test('村側勝利・累計リセット・カスタム配役上限・狼憑き設定の検証',async()=>{
  await save(base(['villager','wolf','seer','villager','villager']));
  for(let i=0;i<5;i++){await call(i,'select',{targetId:ids[i===1?0:1]});await call(i,'confirm');}
  assert.equal((await state()).winner,'village');response=await call(0,'rematch');
  await user(0);await assert.rejects(()=>raw('lobby_command_random','settings',{roomId,revision:response.room.revision,discussionMinutes:3,composition:{...DEFAULT_COMPOSITIONS[5],villager:1,hunter:2}}),/0〜1/);
  await assert.rejects(()=>raw('lobby_command_random','settings',{roomId,revision:response.room.revision,discussionMinutes:3,wolfboundEnabled:true,composition:{villager:0,wolf:1,seer:1,medium:1,knight:1,madman:0,lover:0,baker:0,thief:0,hunter:1}}),/村人が1人以上/);
  const reset=await raw('score_command','reset',{roomId,revision:response.room.revision});assert.equal(reset.room.members.every((m:any)=>m.points===0),true);
 });
 await t.test('怪盗が狼憑きの村人を奪う、偽占い・偽護衛・偽襲撃は影響しない',async()=>{
  let g=base(['thief','villager','wolf','seer','knight']);g.phase='roles';g.players[1]!.wolfbound=g.players[1]!.initialWolfbound=true;await save(g);
  await call(0,'select',{targetId:ids[1]});for(let i=0;i<5;i++)await call(i,'confirm');g=await state();assert.equal(g.players[0]!.wolfbound,true);assert.equal(g.players[1]!.wolfbound,false);
  for(const role of ['seer','knight','wolf']as const){
   g=base(['villager','wolf','seer','knight','villager']);g.players[4]!.initialRole=g.players[4]!.apparentRole=role;g.players[4]!.decoy=true;g.phase='night';await save(g);
   await call(1,'select',{targetId:ids[0],strength:2});await call(2,'select',{targetId:ids[1]});await call(3,'select',{targetId:ids[2]});await call(4,'select',{targetId:role==='wolf'?ids[1]:ids[0],...(role==='wolf'?{strength:3}:{})});
   for(let i=0;i<5;i++)await call(i,'confirm');g=await state();assert.equal(g.victimId,ids[0]);if(role==='seer')assert.equal(g.secrets.find(s=>s.recipientId===ids[4])!.isWolf,false);
  }
 });
 await t.test('連続護衛なし、襲撃希望度、再占いの重複加点なし',async()=>{
  let g=base(['villager','wolf','wolf','knight','seer']);g.phase='night';g.consecutiveGuard=false;g.lastGuardTargets={[ids[3]!]:ids[0]!};await save(g);
  await assert.rejects(()=>call(3,'select',{targetId:ids[0]}),/前の夜/);
  await call(1,'select',{targetId:ids[2],strength:3});await call(2,'select',{targetId:ids[0],strength:1});await call(3,'select',{targetId:ids[4]});await call(4,'select',{targetId:ids[1]});for(let i=0;i<5;i++)await call(i,'confirm');g=await state();assert.equal(g.victimId,ids[2]);assert.equal(g.lastGuardTargets[ids[3]!],ids[4]);assert.equal(g.scoring!.stats[ids[4]!]!.contribution,1);
  g.phase='night';g.phaseId++;g.selections={};g.confirmed=[];await save(g);await call(1,'select',{targetId:ids[0],strength:2});await call(3,'select',{targetId:ids[0]});await call(4,'select',{targetId:ids[1]});for(const i of [0,1,3,4])await call(i,'confirm');g=await state();assert.equal(g.victimId,null);assert.equal(g.scoring!.stats[ids[4]!]!.contribution,1);
 });
 await t.test('主催者切断時に権限移行し、新しい主催者が発砲を中止できる',async()=>{
  await save(base(['hunter','wolf','villager','villager','villager']));await execute();let g=await state();g.deadline=0;await save(g);await db.query("update app_private.members set last_seen=now()-interval'120 seconds'where room_id=$1",[roomId]);
  response=await call(1,'get');assert.equal(response.room.hostId,ids[1]);await call(1,'cancelShot');assert.notEqual((await state()).phase,'hunter');
  await db.exec('reset role');await db.query('update app_private.rooms set host_id=$2 where id=$1',[roomId,ids[0]]);
 });
 await t.test('サイト権限なし・部外者・直接秘密取得は拒否',async()=>{
  await user(0);await assert.rejects(()=>db.query('select state from app_private.games'),/permission denied/);await assert.rejects(()=>db.query("select app_private.hunter_shot('{}'::jsonb,0,true)"),/permission denied/);
  await db.exec('reset role');await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin raise exception'SITE_ACCESS_REQUIRED';end$$`);
  await user(0);await assert.rejects(()=>raw('game_command_random','get',{roomId}),/SITE_ACCESS_REQUIRED/);await assert.rejects(()=>raw('lobby_command_random','get',{roomId}),/SITE_ACCESS_REQUIRED/);
 });
 }finally{await db.close();}
});
