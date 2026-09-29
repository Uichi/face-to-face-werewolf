import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Game } from '../src/domain/game.ts';
import { createGame, applyCommand, viewFor } from '../src/domain/game.ts';
import { DEFAULT_COMPOSITIONS } from '../src/domain/rules.ts';
import type { Room } from '../src/web/types.ts';

type View = ReturnType<typeof viewFor>;
type Response = { ok: boolean; message?: string; room: Room; game: View | null; serverNow: number };

test('Supabaseゲーム処理: 試合完走・再戦・秘密情報・権限・復帰', async t => {
 const db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for (const name of ['202609250001_lobby.sql','202609270003_game.sql','202609270004_membership.sql','202609270005_night_immediate.sql','202609270006_ending.sql','202609270007_thirteen_players.sql','202609280008_madman.sql','202609280009_result_confirmation.sql','202609280009_result_confirmation.sql','202609280010_points.sql','202609280010_points.sql','202609280011_lovers.sql','202609280011_lovers.sql','202609290013_baker.sql','202609290013_baker.sql','202609290014_first_day_no_execution.sql','202609290014_first_day_no_execution.sql','202609290015_public_log.sql','202609290015_public_log.sql']) {
   if(name==='202609290013_baker.sql')await db.exec("create or replace function app_private.assert_site_access() returns void language plpgsql as $$begin return;end$$");
   await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 async function user(id:string) { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); await db.exec('set role authenticated'); }
 async function raw(name:string, action:string, payload:Record<string,unknown>) {
  const result=await db.query<{data:Response}>(`select public.${name}($1,$2::jsonb) data`,[action,JSON.stringify(payload)]);return result.rows[0]!.data;
 }
 async function setup(count:number) {
  const users=Array.from({length:count},()=>randomUUID());
  await db.exec('reset role'); for(const id of users)await db.query('insert into auth.users values($1)',[id]);
  await user(users[0]!);let r=await raw('lobby_command','create',{nickname:'主催者',requestId:randomUUID()});
  for(let i=1;i<count;i++){await user(users[i]!);r=await raw('lobby_command','join',{code:r.room.code,nickname:'参加者'+i});assert.equal(r.ok,true);}
  await user(users[0]!);r=await raw('game_command','start',{roomId:r.room.id,revision:r.room.revision,requestId:randomUUID()});
  assert.equal(r.ok,true);const roomId=r.room.id;
  const memberUsers=new Map(r.room.members.map((m,i)=>[m.id,users[i]!]));
  async function state():Promise<Game>{await db.exec('reset role');const s=await db.query<{state:Game}>('select state from app_private.games where room_id=$1',[roomId]);return s.rows[0]!.state;}
  async function call(memberId:string,action:string,extra:Record<string,unknown>={}) {
   const g=await state();await user(memberUsers.get(memberId)!);r=await raw('game_command',action,{roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID(),...extra});return r;
  }
  async function allConfirm(){const g=await state();for(const p of g.players.filter(p=>p.alive)) await call(p.id,'confirm');}
  async function expire(){await db.exec('reset role');await db.query("update app_private.games set state=jsonb_set(state,'{deadline}','0') where room_id=$1",[roomId]);await call(r.room.hostId,'get');}
  return {roomId,users,memberUsers,state,call,allConfirm,expire,get response(){return r;},get host(){return r.room.hostId;}};
 }
 try {
  for(const count of [5,8,10,11,12,13]) await t.test(`${count}人で役職確認→投票→終了→再戦、個別票は返さない`,async()=>{
   const f=await setup(count);const g=await f.state();
   const wolfIds=g.players.filter(p=>p.role==='wolf').map(p=>p.id);
   const seer=g.players.find(p=>p.role==='seer')!;
   for(const p of g.players){const v=(await f.call(p.id,'get')).game!;
    assert.equal(v.private!.role,p.role);assert.equal(v.public.players.some(p=>'role' in p),false);
    assert.equal((v as unknown as Record<string,unknown>).receipts,undefined);
    assert.equal(v.wolves!==null,p.role==='wolf');
   }
   await f.allConfirm();assert.equal((await f.state()).phase,'firstNight');
   const white=(await f.call(seer.id,'get')).game!.private!.results[0]!;
   assert.notEqual(white.targetId,seer.id);assert.equal(wolfIds.includes(white.targetId),false);
   await f.allConfirm();assert.equal((await f.state()).phase,'discussion');
   await f.call(f.host,'startVote');
   for(const wolfId of wolfIds){
    let current=await f.state();
    if(current.phase==='execution') {
     await f.allConfirm();current=await f.state();
     const living=current.players.filter(p=>p.alive);
     const victim=living.find(p=>p.role==='villager')!;
     for(const p of living){
      if(['wolf','seer','knight'].includes(p.role))await f.call(p.id,'select',{targetId:p.role==='wolf'||p.role==='knight'?victim.id:living.find(v=>v.id!==p.id)!.id});
     }
     await f.allConfirm();assert.equal((await f.state()).phase,'morning');
     assert.equal((await f.state()).victimId,null);await f.allConfirm();await f.call(f.host,'startVote');
    }
    current=await f.state();
    for(const p of current.players.filter(p=>p.alive)){
     const target=p.id===wolfId?current.players.find(v=>v.alive&&v.id!==wolfId)!.id:wolfId;
     await f.call(p.id,'select',{targetId:target});await f.call(p.id,'confirm');
    }
   }
   const end=(await f.call(f.host,'get')).game!;
   assert.equal(end.public.phase,'finished');assert.equal(end.public.winner,'village');
   assert.equal(end.public.ending!.playerId,wolfIds.at(-1));assert.equal(end.public.ending!.cause,'execution');
   assert.equal(end.private,null);assert.equal(end.wolves,null);assert.equal(end.public.players.length,count);
   assert.ok(end.public.players.every(p=>'role' in p));
   const restarted=await f.call(f.host,'rematch');assert.equal(restarted.game,null);assert.equal(restarted.room.status,'waiting');
   await user(f.users[0]!);const next=await raw('game_command','start',{roomId:f.roomId,revision:restarted.room.revision,requestId:randomUUID()});
   assert.notEqual(next.game!.public.id,g.id);assert.equal(next.game!.public.phase,'roles');assert.equal(next.game!.public.ending,null);assert.deepEqual(next.game!.private!.results,[]);
  });
  await t.test('13人で村人12人のカスタム配役も保存・開始できる',async()=>{
   const f=await setup(13);const original=await f.state();
   for(const wolf of original.players.filter(p=>p.role==='wolf'))await f.call(f.host,'remove',{targetId:wolf.id});
   const waiting=await f.call(f.host,'rematch');await user(f.users[0]!);
   const comp={villager:12,wolf:1,seer:0,medium:0,knight: 0, madman: 0};
   const settings=await raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:10,composition:comp});
   assert.equal(settings.ok,true);
   const started=await raw('game_command','start',{roomId:f.roomId,revision:settings.room.revision,requestId:randomUUID()});
   assert.equal(started.ok,true);assert.equal(started.game!.public.players.length,13);assert.deepEqual(started.game!.public.composition,{...comp,lover:0});
  });
  await t.test('狂人に仲間情報・夜の能力を渡さず、白判定・襲撃・共通確認を処理する',async()=>{
   const f=await setup(8),base=await f.state();
   const madman=base.players.find(p=>p.role==='madman')!,seer=base.players.find(p=>p.role==='seer')!;
   const view=(await f.call(madman.id,'get')).game!;assert.equal(view.private!.role,'madman');assert.equal(view.wolves,null);assert.equal(view.public.composition.madman,1);
   for(const wolf of base.players.filter(p=>p.role==='wolf'))assert.equal((await f.call(wolf.id,'get')).game!.wolves!.memberIds.includes(madman.id),false);
   await f.allConfirm();await f.allConfirm();let g=await f.state();
   g={...g,phase:'night',phaseId:g.phaseId+1,deadline:Date.now()+60000,confirmed:[],selections:{}};
   await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),f.roomId]);
   await assert.rejects(f.call(madman.id,'select',{targetId:seer.id}));
   const guardTarget=g.players.find(p=>p.role==='villager')!;
   for(const p of g.players){if(['wolf','seer','knight'].includes(p.role))await f.call(p.id,'select',{targetId:p.role==='knight'?guardTarget.id:madman.id});}
   for(const p of g.players.filter(p=>p.id!==madman.id))await f.call(p.id,'confirm');
   assert.equal((await f.state()).phase,'night');await f.call(madman.id,'confirm');
   assert.equal((await f.state()).victimId,madman.id);
   assert.equal((await f.call(seer.id,'get')).game!.private!.results.at(-1)!.isWolf,false);
   await db.exec('reset role');const killed=(await db.query<{g:Game}>('select app_private.game_kill($1::jsonb,$2,$3) g',[JSON.stringify(base),madman.id,'execution'])).rows[0]!.g;
   assert.equal(killed.secrets.at(-1)!.isWolf,false);
   const counts={players:[base.players.find(p=>p.role==='wolf')!,madman,seer]};
   assert.equal((await db.query<{winner:string|null}>('select app_private.game_winner($1::jsonb) winner',[JSON.stringify(counts)])).rows[0]!.winner,null);
  });
  await t.test('旧5役職のカスタム設定を狂人0として扱い、狂人2人は拒否する',async()=>{
   const f=await setup(5),base=await f.state();await f.call(f.host,'remove',{targetId:base.players.find(p=>p.role==='wolf')!.id});
   let response=await f.call(f.host,'rematch');await user(f.users[0]!);
   const legacy={villager:3,wolf:1,seer:1,medium:0,knight:0};
   response=await raw('lobby_command','settings',{roomId:f.roomId,revision:response.room.revision,discussionMinutes:3,composition:legacy});
   assert.equal(response.ok,true);assert.equal(response.room.composition!.madman,0);
   const invalid=await raw('lobby_command','settings',{roomId:f.roomId,revision:response.room.revision,discussionMinutes:3,composition:{villager:1,wolf:1,seer:1,medium:0,knight:0,madman:2}});assert.equal(invalid.ok,false);
   await db.exec('reset role');await db.query('update app_private.rooms set composition=$1::jsonb where id=$2',[JSON.stringify(legacy),f.roomId]);
   await user(f.users[0]!);const started=await raw('game_command','start',{roomId:f.roomId,revision:response.room.revision,requestId:randomUUID()});
   assert.equal(started.game!.public.composition.madman,0);
  });
  await t.test('処刑・朝は生存者全員確認のみで進み、死んだ主催者・未確認者・再送を正しく扱う',async()=>{
   for(const phase of ['execution','morning'] as const){
    const f=await setup(8);await f.call(f.host,'remove',{targetId:f.host});let g=await f.state();
    g={...g,phase,phaseId:g.phaseId+1,confirmed:[],selections:{},deadline:null};
    await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),f.roomId]);
    const living=g.players.filter(p=>p.alive);
    await assert.rejects(f.call(f.host,'next'));await assert.rejects(f.call(f.host,'confirm'));
    for(const p of living.slice(0,-1))await f.call(p.id,'confirm');
    const waiting=(await f.call(living[0]!.id,'get')).game!;assert.equal(waiting.public.phase,phase);assert.equal(waiting.public.requiredCount,living.length);assert.equal(waiting.public.completedCount,living.length-1);assert.equal(waiting.public.resultConfirmation,true);
    const last=living.at(-1)!;await user(f.memberUsers.get(last.id)!);
    const command={roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()};
    const done=await raw('game_command','confirm',command);assert.equal(done.game!.public.phase,phase==='execution'?'night':'discussion');
    const retry=await raw('game_command','confirm',command);assert.deepEqual(retry.game,done.game);
    const stale=await raw('game_command','confirm',{...command,requestId:randomUUID()});assert.equal(stale.ok,false);
   }
  });
  await t.test('結果確認待ちの参加者を途中脱落にすると、残り全員の確認で進む',async()=>{
   const f=await setup(8);let g=await f.state();g={...g,phase:'execution',phaseId:g.phaseId+1,confirmed:[],selections:{},deadline:null};
   await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),f.roomId]);
   const missing=g.players.find(p=>p.role==='villager'&&p.id!==f.host)!;
   for(const p of g.players.filter(p=>p.id!==missing.id))await f.call(p.id,'confirm');
   assert.equal((await f.state()).phase,'execution');
   await f.call(f.host,'remove',{targetId:missing.id});assert.equal((await f.state()).phase,'night');
  });
  await t.test('旧段階・二重送信・他人の操作・直接の秘密データ取得を検証',async()=>{
   const f=await setup(5);const g=await f.state();const target=g.players.find(p=>p.id!==f.host && p.role!=='wolf')!.id;
   await user(f.users[0]!);
   const cmd={roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()};
   const first=await raw('game_command','confirm',cmd);const second=await raw('game_command','confirm',cmd);
   assert.deepEqual(first.game,second.game);
   await assert.rejects(raw('game_command','remove',{...cmd,targetId:target}));
   await assert.rejects(db.query('select state from app_private.games'));
   await assert.rejects(db.query("select app_private.game_view('{}','x')"));
   await assert.rejects(f.call(target,'remove',{targetId:g.players[2]!.id}));
   await f.allConfirm();await user(f.users[0]!);
   const stale=await raw('game_command','confirm',{...cmd,requestId:randomUUID()});assert.equal(stale.ok,false);
   const retry=await raw('game_command','confirm',cmd);assert.equal(retry.ok,true);assert.equal(retry.game!.public.phase,'firstNight');
   await f.call(f.host,'remove',{targetId:target});const dead=(await f.call(target,'get')).game!;assert.equal(dead.public.ending,null);assert.equal(dead.private,null);assert.equal(dead.wolves,null);
   await assert.rejects(f.call(target,'confirm'));
   const stranger=randomUUID();await db.exec('reset role');await db.query('insert into auth.users values($1)',[stranger]);await user(stranger);
   await assert.rejects(raw('game_command','get',{roomId:f.roomId}));
  });
  await t.test('夜の途中脱落で全操作取消・時間リセット、既存白通知は保持',async()=>{
   const f=await setup(8);await f.allConfirm();await f.allConfirm();
   await db.exec('reset role');let g=await f.state();
   g.phase='night';g.deadline=Date.now()+60000;g.phaseId++;
   await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),f.roomId]);
   const wolf=g.players.find(p=>p.role==='wolf')!, victim=g.players.find(p=>p.role==='villager')!;
   await f.call(wolf.id,'select',{targetId:victim.id});await f.call(wolf.id,'confirm');
   const old=await f.state();await f.call(f.host,'remove',{targetId:victim.id});const next=await f.state();
   assert.equal(next.phase,'night');assert.ok(next.phaseId>old.phaseId);assert.deepEqual(next.confirmed,[]);assert.deepEqual(next.selections,{});
   assert.deepEqual(next.secrets,old.secrets);assert.ok(next.deadline!>=Date.now()+58000);
  });
  await t.test('主催者脱落後も最後の夜確認で即処理し、再送で能力や襲撃を二重実行しない',async()=>{
   const f=await setup(8);await f.allConfirm();await f.allConfirm();
   await f.call(f.host,'remove',{targetId:f.host});
   let g=await f.state();g.phase='night';g.phaseId++;g.deadline=Date.now()+120000;g.confirmed=[];g.selections={};
   await db.exec('reset role');await db.query('update app_private.games set state=$1::jsonb where room_id=$2',[JSON.stringify(g),f.roomId]);
   const living=g.players.filter(p=>p.alive), victim=living.find(p=>p.role==='villager')!;
   for(const p of living){
    if(['wolf','seer','knight'].includes(p.role))await f.call(p.id,'select',{targetId:p.role==='seer'?living.find(v=>v.id!==p.id)!.id:victim.id});
   }
   for(const p of living.slice(0,-1))await f.call(p.id,'confirm');
   assert.equal((await f.state()).phase,'night');
   const last=living.at(-1)!;await user(f.memberUsers.get(last.id)!);
   const command={roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()};
   const first=await raw('game_command','confirm',command);
   assert.equal(first.game!.public.phase,'morning');assert.ok(Date.now()<g.deadline!);
   const retry=await raw('game_command','confirm',command);assert.deepEqual(retry.game,first.game);
   const latest=await f.state();assert.equal(latest.day,g.day+1);
   assert.equal(latest.secrets.length,g.secrets.length+(living.some(p=>p.role==='seer')?1:0));
   const deadHost=(await f.call(f.host,'get')).game!;assert.equal(deadHost.private,null);assert.equal(deadHost.public.phase,'morning');
  });
  await t.test('最後の脱落理由を正確に公開し、古い処刑・襲撃と取り違えない',async()=>{
   await db.exec('reset role');
   const base=createGame({id:'ending',hostId:'v0',playerIds:['v0','v1','v2','w','s'],composition:DEFAULT_COMPOSITIONS[5]!},0,()=>0);
   const night={...base,phase:'night',deadline:60000,confirmed:['v0','w','s'],selections:{w:'s',s:'w'},
     players:base.players.map(p=>({...p,alive:!['v1','v2'].includes(p.id)})),
     voteResult:{counts:{v2:3},executedId:'v2',runoffIds:[]},lastElimination:{playerId:'v2',cause:'execution',day:1}};
   const resolved=(await db.query<{g:Game}>('select app_private.game_settle($1::jsonb,1) g',[JSON.stringify(night)])).rows[0]!.g;
   const end=(await db.query<{v:View}>('select app_private.game_view($1::jsonb,$2) v',[JSON.stringify(resolved),'v0'])).rows[0]!.v;
   assert.equal(end.public.winner,'wolves');assert.deepEqual(end.public.ending,{playerId:'s',cause:'attack',day:1});
   const vote={...base,phase:'vote',deadline:60000,confirmed:base.players.map(p=>p.id),selections:{v0:'w',v1:'w',v2:'w',w:'v0',s:'w'},victimId:'v1',lastElimination:{playerId:'v1',cause:'attack',day:1}};
   const executed=(await db.query<{g:Game}>('select app_private.game_settle($1::jsonb,1) g',[JSON.stringify(vote)])).rows[0]!.g;
   assert.equal(executed.winner,'village');assert.deepEqual(executed.lastElimination,{playerId:'w',cause:'execution',day:1});
   const f=await setup(5),g=await f.state(),wolf=g.players.find(p=>p.role==='wolf')!;
   const removed=(await f.call(f.host,'remove',{targetId:wolf.id})).game!;
   assert.equal(removed.public.phase,'finished');assert.deepEqual(removed.public.ending,{playerId:wolf.id,cause:'disconnect',day:1});
  });
  await t.test('純粋な進行処理とSQLの決選・夜の解決が一致する',async()=>{
   await db.exec('reset role');
   let g=createGame({id:'reference',hostId:'v0',playerIds:['v0','v1','v2','w','s','m','k'],composition:DEFAULT_COMPOSITIONS[7]!},0,()=>0);
   g={...g,phase:'vote',deadline:60000,confirmed:g.players.map(p=>p.id),selections:{v0:'v1',v1:'v0',v2:'v0',w:'v1',s:'v2',m:'v2',k:'m'}};
   async function settle(value:Game){return (await db.query<{g:Game}>('select app_private.game_settle($1::jsonb,$2::bigint) g',[JSON.stringify(value),60000])).rows[0]!.g;}
   let expected=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'ref1',actorId:null,action:{type:'tick'}},60000,()=>0);
   let actual=await settle(g);assert.equal(actual.phase,expected.phase);assert.deepEqual([...actual.runoffIds].sort(),[...expected.runoffIds].sort());assert.deepEqual(actual.voteResult!.counts,expected.voteResult!.counts);
   g={...g,phase:'night',confirmed:g.players.map(p=>p.id),selections:{w:'s',s:'w',k:'v0'}};
   expected=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:'ref2',actorId:null,action:{type:'tick'}},60000,()=>0);
   actual=await settle(g);assert.deepEqual(actual.players,expected.players);assert.deepEqual(actual.secrets,expected.secrets);assert.equal(actual.victimId,'s');
   const view=(await db.query<{v:View}>('select app_private.game_view($1::jsonb,$2) v',[JSON.stringify(actual),'s'])).rows[0]!.v;assert.equal(view.private,null);
  });
  await t.test('採点: 勝敗確定・再送・再接続・再戦で一度だけ累計、非公開実績を返さない',async()=>{
   const f=await setup(8);let g=await f.state();
   assert.deepEqual(g.scoring!.victoryPoints,{villager:5,wolf:6,seer:5,medium:5,knight:5,madman:6,lover:5,baker:5});
   for(const p of g.players){const v=await f.call(p.id,'get');assert.equal(v.game!.public.scores,null);assert.ok(!JSON.stringify(v).includes('discovered'));assert.ok(!JSON.stringify(v).includes('"stats"'));assert.ok(v.room.members.every(m=>m.points===0));}
   const wolves=g.players.filter(p=>p.role==='wolf');
   const dead=g.players.find(p=>p.role==='villager')!;
   await f.call(f.host,'remove',{targetId:dead.id});
   await f.call(f.host,'remove',{targetId:wolves[0]!.id});
   g=await f.state();g.phase='vote';g.selections=Object.fromEntries(g.players.filter(p=>p.alive).map(p=>[p.id,p.id===wolves[1]!.id?g.players.find(x=>x.alive && x.id!==p.id)!.id:wolves[1]!.id]));
   const last=g.players.find(p=>p.alive)!;g.confirmed=g.players.filter(p=>p.alive&&p.id!==last.id).map(p=>p.id);
   await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);
   const command={roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()};await user(f.memberUsers.get(last.id)!);
   const first=await raw('game_command','confirm',command);assert.equal(first.game!.public.phase,'finished');
   const scores=first.game!.public.scores!;assert.equal(scores.length,8);
   for(const p of g.players){const s=scores.find(s=>s.playerId===p.id)!;const win=!['wolf','madman'].includes(p.role);assert.equal(s.victory,win?5:0);assert.equal(s.contribution,win&&p.alive?1:0);assert.equal(s.survival,0);assert.equal(first.room.members.find(m=>m.id===p.id)!.points,s.total);}
   const retry=await raw('game_command','confirm',command);assert.deepEqual(retry.game,first.game);assert.deepEqual(retry.room.members,first.room.members);
   await user(f.memberUsers.get(f.host)!);const read=await raw('game_command','get',{roomId:f.roomId});assert.deepEqual(read.room.members,first.room.members);
   const waiting=await f.call(f.host,'rematch');assert.deepEqual(waiting.room.members,first.room.members);
   const start=await raw('game_command','start',{roomId:f.roomId,revision:waiting.room.revision,requestId:randomUUID()});assert.equal(start.game!.public.scores,null);assert.deepEqual(start.room.members,first.room.members);
  });
  await t.test('採点: 設定の検証・権限・配点確定・累計リセット・退出と再参加',async()=>{
   const f=await setup(5);const g=await f.state();const wolf=g.players.find(p=>p.role==='wolf')!;
   await user(f.users[0]!);await assert.rejects(raw('score_command','reset',{roomId:f.roomId,revision:f.response.room.revision}));
   assert.equal((await raw('lobby_command','settings',{roomId:f.roomId,revision:f.response.room.revision,discussionMinutes:3,composition:null,victoryPoints:{}})).ok,false);
   await f.call(f.host,'remove',{targetId:wolf.id});let waiting=await f.call(f.host,'rematch');
   const other=waiting.room.members.find(m=>m.id!==f.host)!;
   await user(f.memberUsers.get(other.id)!);await assert.rejects(raw('score_command','reset',{roomId:f.roomId,revision:waiting.room.revision}));
   assert.equal((await raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:3,composition:null,victoryPoints:{}})).ok,false);
   await user(f.users[0]!);
   const points={villager:0,wolf:10,seer:3,medium:4,knight:2,madman:8,lover:5,baker:5};
   for(const value of [-1,11,1.5,'2',null])await assert.rejects(raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:3,composition:null,victoryPoints:{...points,wolf:value}}));
   await assert.rejects(raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:3,composition:null,victoryPoints:{...points,extra:1}}));
   let updated=await raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:3,composition:null,victoryPoints:points});assert.equal(updated.ok,true);assert.deepEqual(updated.room.victoryPoints,points);
   assert.equal(updated.room.members.reduce((n,m)=>n+m.points!,0),20);
   const staleRevision=waiting.room.revision;await assert.rejects(raw('score_command','reset',{roomId:f.roomId,revision:staleRevision}));
   const resetCommand={roomId:f.roomId,revision:updated.room.revision};updated=await raw('score_command','reset',resetCommand);assert.ok(updated.room.members.every(m=>m.points===0));assert.deepEqual(updated.room.victoryPoints,points);
   await assert.rejects(raw('score_command','reset',resetCommand));
   // Old clients that omit victoryPoints must preserve the new setting.
   updated=await raw('lobby_command','settings',{roomId:f.roomId,revision:updated.room.revision,discussionMinutes:4,composition:null});assert.deepEqual(updated.room.victoryPoints,points);
   await raw('game_command','start',{roomId:f.roomId,revision:updated.room.revision,requestId:randomUUID()});let next=await f.state();assert.deepEqual(next.scoring!.victoryPoints,points);
   await f.call(f.host,'remove',{targetId:next.players.find(p=>p.role==='wolf')!.id});waiting=await f.call(f.host,'rematch');
   const scoresBefore=waiting.room.members.find(m=>m.id===other.id)!.points;
   await user(f.memberUsers.get(other.id)!);await raw('membership_command','leave',{roomId:f.roomId,memberId:other.id,revision:waiting.room.revision});
   const joined=await raw('lobby_command','join',{code:waiting.room.code,nickname:other.nickname});const rejoined=joined.room.members.find(m=>m.nickname===other.nickname)!;assert.notEqual(rejoined.id,other.id);assert.equal(rejoined.points,0);assert.ok(scoresBefore!>=0);
   // Internal award/reset state is not directly accessible to authenticated users.
   await assert.rejects(db.query('select points from app_private.members'));
   await assert.rejects(db.query("select app_private.score_award($1,'{}')",[f.roomId]));
  });
  await t.test('採点: SQLとドメインで決選・占い重複・護衛・最終夜・退場の実績が一致',async()=>{
   const f=await setup(8);const original=await f.state();
   const id=(role:string,index=0)=>original.players.filter(p=>p.role===role)[index]!.id;
   const [w0,w1,s,k,v0,v1,c]=[id('wolf'),id('wolf',1),id('seer'),id('knight'),id('villager'),id('villager',1),id('madman')];
   async function settle(g:Game){
    g.lastTime=0;
    g.confirmed=g.players.filter(p=>p.alive).map(p=>p.id);
    const expected=applyCommand(g,{gameId:g.id,phaseId:g.phaseId,requestId:randomUUID(),actorId:null,action:{type:'tick'}},Date.now(),()=>0);
    await db.exec('reset role');const actual=(await db.query<{g:Game}>('select app_private.game_settle($1::jsonb,$2::bigint) g',[JSON.stringify(g),Date.now()])).rows[0]!.g;
    assert.deepEqual(actual.scoring,expected.scoring);assert.equal(actual.winner,expected.winner);return actual;
   }
   let g=structuredClone(original);g=await settle(g);g=await settle(g);assert.deepEqual(g.scoring!.stats,{});
   for(let n=0;n<5;n++){g.phase='night';g.selections={[w0]:v0,[w1]:v0,[s]:w0,[k]:v0};g=await settle(g);}
   assert.equal(g.scoring!.stats[s]!.contribution,1);assert.equal(g.scoring!.stats[k]!.contribution,3);assert.ok(Object.values(g.scoring!.stats).every(s=>s.survival===3));
   // Tie then tied runoff: neither awards any ballot points.
   g=structuredClone(original);g.phase='vote';g.selections=Object.fromEntries(g.players.map((p,i)=>[p.id,p.id===w0?v0:p.id===v0?w0:i<4?w0:v0]));
   const others=g.players.filter(p=>![w0,v0].includes(p.id));g.selections={[w0]:v0,[v0]:w0,...Object.fromEntries(others.map((p,i)=>[p.id,i<3?w0:v0]))};
   const ballots={...g.selections};g=await settle(g);assert.equal(g.phase,'runoff');assert.deepEqual(g.scoring!.stats,{});g.selections=ballots;g=await settle(g);assert.equal(g.voteResult!.executedId,null);assert.deepEqual(g.scoring!.stats,{});
   // Final night counts surviving players, but not the seer being attacked.
   g=structuredClone(original);g.phase='night';g.players=g.players.map(p=>({...p,alive:[w0,w1,s,v0,v1].includes(p.id)}));g.selections={[w0]:s,[w1]:s,[s]:w0};g=await settle(g);
   assert.equal(g.winner,'wolves');assert.equal(g.scoring!.stats[s]!.contribution,1);assert.equal(g.scoring!.stats[s]!.survival,0);assert.equal(g.scoring!.stats[w0]!.survival,1);
   const award=(await db.query<{g:Game}>('select app_private.score_award($1,$2::jsonb) g',[f.roomId,JSON.stringify(g)])).rows[0]!.g;
   assert.equal(award.scores!.find(p=>p.playerId===s)!.total,0);assert.equal(award.scores!.find(p=>p.playerId===c)!.victory,6);
   // SQL view only exposes aggregate finished scores, never counters or discovered targets.
   const view=(await db.query<{v:View}>('select app_private.game_view($1::jsonb,$2) v',[JSON.stringify(award),v0])).rows[0]!.v;
   assert.deepEqual(view.public.scores,award.scores);assert.ok(!JSON.stringify(view).includes('discovered'));
  });
  await t.test('採点: 更新前の試合へ遡及せず、旧試合でも最後まで進行可能',async()=>{
   const f=await setup(5);const g=await f.state();delete g.scoring;
   await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);
   const finished=await f.call(f.host,'remove',{targetId:g.players.find(p=>p.role==='wolf')!.id});assert.equal(finished.game!.public.phase,'finished');assert.equal(finished.game!.public.scores,null);assert.ok(finished.room.members.every(m=>m.points===0));
  });
  async function loversSetup() {
   const f=await setup(7);const initial=await f.state();
   await f.call(f.host,'remove',{targetId:initial.players.find(p=>p.role==='wolf')!.id});
   const wait=await f.call(f.host,'rematch');await user(f.users[0]!);
   const composition={villager:1,wolf:1,seer:1,medium:1,knight:1,madman:0,lover:2};
   const settings=await raw('lobby_command','settings',{roomId:f.roomId,revision:wait.room.revision,discussionMinutes:3,composition});assert.equal(settings.ok,true);
   await raw('game_command','start',{roomId:f.roomId,revision:settings.room.revision,requestId:randomUUID()});
   await f.call(f.host,'get');
   return f;
  }
  await t.test('恋人: カスタム配役は0か2人、旧配役互換・配点・再適用を検証',async()=>{
   const f=await loversSetup();const g=await f.state();assert.equal(g.players.filter(p=>p.role==='lover').length,2);assert.equal(f.response.room.loverRole,true);
   assert.equal(g.scoring!.victoryPoints.lover,5);
   await f.call(f.host,'remove',{targetId:g.players.find(p=>p.role==='wolf')!.id});let wait=await f.call(f.host,'rematch');await user(f.users[0]!);
   for(const lover of [1,3,4,-1,1.5]){
    const bad=await raw('lobby_command','settings',{roomId:f.roomId,revision:wait.room.revision,discussionMinutes:3,composition:{villager:3-lover,wolf:1,seer:1,medium:1,knight:1,madman:0,lover}});assert.equal(bad.ok,false);
   }
   const victoryPoints={...wait.room.victoryPoints!,lover:7};
   wait=await raw('lobby_command','settings',{roomId:f.roomId,revision:wait.room.revision,discussionMinutes:3,composition:{villager:1,wolf:1,seer:1,medium:1,knight:1,madman:0,lover:2},victoryPoints});assert.equal(wait.ok,true);
   await db.exec('reset role');await db.exec(await readFile(new URL('../supabase/migrations/202609280011_lovers.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../supabase/migrations/202609290013_baker.sql',import.meta.url),'utf8'));await user(f.users[0]!);
   const kept=await raw('lobby_command','get',{roomId:f.roomId});assert.equal(kept.room.victoryPoints!.lover,7);assert.equal(kept.room.composition!.lover,2);
   const {lover:unused,...oldPoints}=victoryPoints;
   const old=await raw('lobby_command','settings',{roomId:f.roomId,revision:kept.room.revision,discussionMinutes:3,composition:{villager:3,wolf:1,seer:1,medium:1,knight:1,madman:0},victoryPoints:oldPoints});assert.equal(old.ok,true);assert.equal(old.room.composition!.lover,0);assert.equal(old.room.victoryPoints!.lover,7);
  });
  await t.test('恋人: 相方は本人のみ、夜の対象選択不可、白判定・護衛成功で2人生存',async()=>{
   const f=await loversSetup();let g=await f.state();const id=(role:string,index=0)=>g.players.filter(p=>p.role===role)[index]!.id;
   const [a,b,w,s,k,v]=[id('lover'),id('lover',1),id('wolf'),id('seer'),id('knight'),id('villager')];
   for(const p of g.players){const view=(await f.call(p.id,'get')).game!;assert.equal(view.private!.loverId,p.id===a?b:p.id===b?a:null);assert.ok(view.public.players.every(p=>!('role' in p)));if(p.role==='lover')assert.equal(view.wolves,null);}
   g.phase='night';g.selections={[w]:a,[s]:a,[k]:a};g.confirmed=[];
   await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);
   await assert.rejects(f.call(a,'select',{targetId:v}));await f.allConfirm();
   const after=await f.state();assert.equal(after.phase,'morning');assert.ok(after.players.filter(p=>p.role==='lover').every(p=>p.alive));assert.equal(after.secrets.at(-1)!.isWolf,false);assert.equal(after.scoring!.stats[a]!.survival,1);assert.equal(after.scoring!.stats[b]!.survival,1);assert.equal(after.scoring!.stats[k]!.contribution,1);
   assert.deepEqual(f.response.game!.public.followedIds,[]);
  });
  for(const cause of ['execution','attack','disconnect'] as const) await t.test(`恋人: ${cause}で2人脱落、確認人数・公開結果・採点が正しい`,async()=>{
   const f=await loversSetup();let g=await f.state();const id=(role:string,index=0)=>g.players.filter(p=>p.role===role)[index]!.id;
   const [a,b,w,s,k,v,m]=[id('lover'),id('lover',1),id('wolf'),id('seer'),id('knight'),id('villager'),id('medium')];
   if(cause==='execution'){
    g.phase='vote';g.selections=Object.fromEntries(g.players.map(p=>[p.id,p.id===a?v:a]));g.confirmed=[];
   }else if(cause==='attack'){
    g.phase='night';g.selections={[w]:a,[s]:w,[k]:b};g.confirmed=[];
   }else{g.phase='roles';g.confirmed=[a,b,v];}
   await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);
   if(cause==='disconnect')await f.call(f.host,'remove',{targetId:a});else await f.allConfirm();
   const after=await f.state();assert.ok(after.players.filter(p=>p.role==='lover').every(p=>!p.alive));assert.equal(after.players.filter(p=>p.alive).length,5);assert.equal(after.phase==='finished',false);
   assert.deepEqual(after.lastElimination!.followedIds,[b]);assert.equal(after.lastElimination!.playerId,a);
   assert.equal((await f.call(a,'get')).game!.private,null);assert.equal((await f.call(b,'get')).game!.private,null);assert.equal(f.response.game!.public.requiredCount,5);
   if(cause==='disconnect'){assert.deepEqual(after.removals.map(p=>p.playerId),[a,b]);assert.deepEqual(after.confirmed,[v]);}
   else assert.deepEqual(f.response.game!.public.followedIds,[b]);
   assert.equal(after.secrets.filter(s=>s.kind==='medium').length,cause==='execution'?1:0);
   if(cause==='execution'){const medium=(await f.call(m,'get')).game!.private!;assert.equal(medium.results.at(-1)!.targetId,a);assert.equal(medium.results.at(-1)!.isWolf,false);}
   assert.equal(after.scoring!.stats[a]?.survival??0,0);assert.equal(after.scoring!.stats[b]?.survival??0,0);
   if(cause==='attack')assert.equal(after.scoring!.stats[k]!.contribution,0);
   await assert.rejects(f.call(b,'confirm'));
   const end=await f.call(f.host,'remove',{targetId:w});assert.equal(end.game!.public.winner,'village');for(const id of [a,b])assert.equal(end.game!.public.scores!.find(s=>s.playerId===id)!.victory,5);
   const restart=await f.call(f.host,'rematch');assert.equal(restart.room.composition!.lover,2);await user(f.users[0]!);await raw('game_command','start',{roomId:f.roomId,revision:restart.room.revision,requestId:randomUUID()});assert.ok((await f.state()).players.every(p=>p.alive));
  });
  await t.test('恋人: 後追いで即終了した最終夜にも2人を表示し、再送で再加点しない',async()=>{
   const f=await loversSetup();let g=await f.state();const a=g.players.find(p=>p.role==='lover')!,b=g.players.find(p=>p.role==='lover'&&p.id!==a.id)!,w=g.players.find(p=>p.role==='wolf')!,v=g.players.find(p=>p.role==='villager')!;
   g.players=g.players.map(p=>({...p,alive:[a.id,b.id,w.id,v.id].includes(p.id)}));g.phase='night';g.selections={[w.id]:a.id};g.confirmed=[a.id,b.id,w.id];
   await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);await user(f.memberUsers.get(v.id)!);
   const command={roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()};const first=await raw('game_command','confirm',command);assert.equal(first.game!.public.phase,'finished');assert.equal(first.game!.public.winner,'wolves');assert.deepEqual(first.game!.public.ending!.followedIds,[b.id]);assert.equal(first.game!.public.ending!.playerId,a.id);
   assert.equal(first.game!.public.scores!.find(p=>p.playerId===a.id)!.total,0);assert.equal(first.game!.public.scores!.find(p=>p.playerId===b.id)!.total,0);assert.equal(first.game!.public.scores!.find(p=>p.playerId===w.id)!.survival,1);
   const retry=await raw('game_command','confirm',command);assert.deepEqual(retry.room.members,first.room.members);assert.deepEqual(retry.game,first.game);
  });
  await t.test('パン屋: 設定・配布・朝のパン通知・脱落後の通知なし',async()=>{
   const f=await setup(5);let g=await f.state();await f.call(f.host,'remove',{targetId:g.players.find(p=>p.role==='wolf')!.id});
   let wait=await f.call(f.host,'rematch');await user(f.users[0]!);
   const composition={villager:2,wolf:1,seer:1,medium:0,knight:0,madman:0,lover:0,baker:1};
   wait=await raw('lobby_command_baker','settings',{roomId:f.roomId,revision:wait.room.revision,discussionMinutes:3,composition,victoryPoints:wait.room.victoryPoints});
   assert.equal(wait.room.bakerRole,true);assert.equal(wait.room.composition!.baker,1);assert.equal(wait.room.victoryPoints!.baker,5);
   const started=await raw('game_command_baker','start',{roomId:f.roomId,revision:wait.room.revision,requestId:randomUUID()});
   g=await f.state();assert.equal(g.players.filter(p=>p.role==='baker').length,1);assert.equal(started.game!.public.composition.baker,1);
   g.phase='morning';g.phaseId+=1;g.confirmed=[];await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);await user(f.users[0]!);
   let morning=await raw('game_command_baker','get',{roomId:f.roomId});assert.equal(morning.game!.public.breadDelivered,true);
   g.players.find(p=>p.role==='baker')!.alive=false;await db.exec('reset role');await db.query('update app_private.games set state=$1 where room_id=$2',[JSON.stringify(g),f.roomId]);await user(f.users[0]!);
   morning=await raw('game_command_baker','get',{roomId:f.roomId});assert.equal(morning.game!.public.breadDelivered,false);
  });
  await t.test('初日の「誰も処刑しない」は保存・集計され、最多なら全員生存する',async()=>{
   await db.exec('reset role');await db.exec(await readFile(new URL('../supabase/migrations/202609290014_first_day_no_execution.sql',import.meta.url),'utf8'));
   const f=await setup(5);await f.allConfirm();await f.allConfirm();await f.call(f.host,'startVote');
   let g=await f.state();const living=g.players.filter(p=>p.alive);
   for(let i=0;i<living.length;i++){
    const p=living[i]!;await user(f.memberUsers.get(p.id)!);
    const targetId=i<3?'__no_execution__':living.find(candidate=>candidate.id!==p.id)!.id;
    await raw('game_command_first_day','select',{roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID(),targetId});
    g=await f.state();
    await raw('game_command_first_day','confirm',{roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()});
    g=await f.state();
   }
   assert.equal(g.phase,'execution',JSON.stringify({voteResult:g.voteResult,selections:g.selections,winner:g.winner,players:g.players}));assert.equal(g.voteResult!.executedId,null);assert.equal(g.voteResult!.counts.__no_execution__,3);assert.ok(g.players.every(p=>p.alive));
  });
  await t.test('公開ログは処刑を保存し、全参加者へ同じ内容を返す',async()=>{
   const f=await setup(5);await f.allConfirm();await f.allConfirm();await f.call(f.host,'startVote');
   let g=await f.state();const living=g.players.filter(p=>p.alive),wolf=living.find(p=>p.role==='wolf')!;
   for(let i=0;i<living.length;i++){
    const p=living[i]!,targetId=p.id===wolf.id?living.find(candidate=>candidate.id!==p.id)!.id:wolf.id;
    await f.call(p.id,'select',{targetId});
    if(i<living.length-1)await f.call(p.id,'confirm');
   }
   const last=living.at(-1)!;g=await f.state();await user(f.memberUsers.get(last.id)!);
   const response=await raw('game_command_public_log','confirm',{roomId:f.roomId,gameId:g.id,phaseId:g.phaseId,requestId:randomUUID()});
   assert.equal(response.game!.public.publicLog.length,1);assert.equal(response.game!.public.publicLog[0]!.kind,'execution');assert.equal(response.game!.public.publicLog[0]!.playerId,wolf.id);
   const persisted=await f.state();assert.equal(persisted.publicLog!.length,1);
  });
 }finally{await db.close();}
});
