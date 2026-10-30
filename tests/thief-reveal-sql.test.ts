import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createSoloSession } from '../src/web/solo-test.ts';

test('怪盗答え合わせSQL：終了後だけ相手を返し、旧データ・権限・再適用を維持',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create schema extensions;create function extensions.gen_random_bytes(n integer)returns bytea language sql volatile as $$select decode(repeat('00',n),'hex')$$;create function extensions.gen_random_uuid()returns uuid language sql volatile as $$select gen_random_uuid()$$;`);
 const dir=new URL('../supabase/migrations/',import.meta.url);
 for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')&&!f.includes('0002_realtime')&&!f.includes('0012_site_password')).sort()){
  if(file.includes('0013_baker'))await db.exec(`create or replace function app_private.assert_site_access()returns void language plpgsql as $$begin return;end$$`);
  await db.exec(await readFile(new URL(file,dir),'utf8'));
 }
 const sql=await readFile(new URL('202610300028_thief_reveal.sql',dir),'utf8');await db.exec(sql);
 const game=createSoloSession('thief').game;game.players[0]!.initialRole='thief';game.players[0]!.role='villager';game.players[0]!.apparentRole='villager';game.players[1]!.decoy=true;game.players[1]!.initialRole='villager';game.players[1]!.role='villager';
 const view=async(viewer:string)=>(await db.query<{v:any}>('select app_private.bodybuilder_view($1::jsonb,$2) v',[JSON.stringify(game),viewer])).rows[0]!.v;
 for(const phase of ['roles','firstNight','night','morning','hunter'] as const){game.phase=phase;for(const player of game.players){const v=await view(player.id);assert.equal(v.public.thiefReveal,undefined);if(player.id!=='solo-0')assert.equal(v.private?.thiefExchange,null);}}
 game.phase='finished';for(const player of game.players){const v=await view(player.id);assert.deepEqual(v.public.thiefReveal,{thiefId:'solo-0',targetId:'solo-1',stolenRole:'villager'});assert.equal(v.private,null);}
 await assert.rejects(()=>view('outsider'),/参加者/);
 await db.exec('set role authenticated');await assert.rejects(()=>view('solo-0'),/permission denied/);await db.exec('reset role');
 delete game.players[1]!.decoy;game.players[0]!.role='thief';assert.equal((await view('solo-0')).public.thiefReveal,undefined);
 }finally{await db.close();}
});
