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
 for (const name of ['202609250001_lobby.sql','202609270003_game.sql','202609270005_night_immediate.sql','202609270006_ending.sql','202609270007_thirteen_players.sql','202609270007_thirteen_players.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
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
     await f.call(f.host,'next');current=await f.state();
     const living=current.players.filter(p=>p.alive);
     const victim=living.find(p=>p.role==='villager')!;
     for(const p of living){
      if(['wolf','seer','knight'].includes(p.role))await f.call(p.id,'select',{targetId:p.role==='wolf'||p.role==='knight'?victim.id:living.find(v=>v.id!==p.id)!.id});
     }
     await f.allConfirm();assert.equal((await f.state()).phase,'morning');
     assert.equal((await f.state()).victimId,null);await f.call(f.host,'next');await f.call(f.host,'startVote');
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
   const comp={villager:12,wolf:1,seer:0,medium:0,knight:0};
   const settings=await raw('lobby_command','settings',{roomId:f.roomId,revision:waiting.room.revision,discussionMinutes:10,composition:comp});
   assert.equal(settings.ok,true);
   const started=await raw('game_command','start',{roomId:f.roomId,revision:settings.room.revision,requestId:randomUUID()});
   assert.equal(started.ok,true);assert.equal(started.game!.public.players.length,13);assert.deepEqual(started.game!.public.composition,comp);
  });
  await t.test('旧段階・二重送信・他人の操作・直接の秘密データ取得を検証',async()=>{
   const f=await setup(5);const g=await f.state();const target=g.players[1]!.id;
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
 }finally{await db.close();}
});
