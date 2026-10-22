-- Apply after 026. Prepare valid rules for 5-13 planned players before the roster fills.
begin;
do $$begin if to_regprocedure('app_private.roster_composition(jsonb,integer)') is null then raise exception '先に026（lobby_settings）のSQLを適用してください。';end if;end$$;
alter table app_private.rooms add column if not exists planned_players integer check(planned_players between 5 and 13);
create or replace function app_private.snapshot(target uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'room', jsonb_build_object(
    'id', r.id, 'code', r.code, 'hostId', r.host_id, 'status', r.status,
    'plannedPlayers',r.planned_players,'revision', r.revision, 'discussionMinutes', r.discussion_minutes,
    'randomComposition',true,'compositionMode',r.composition_mode,'randomCandidates',r.random_candidates,'fixedWolves',(app_private.default_composition(coalesce(r.planned_players,(select count(*)::integer from app_private.members where room_id=r.id)))->'wolf'),
    'composition', case when r.composition_mode='random' then null else coalesce('{"madman":0,"lover":0}'::jsonb || r.composition, app_private.default_composition(coalesce(r.planned_players,(select count(*)::integer from app_private.members where room_id = r.id)))) end,
    'loverRole',true,'customComposition', r.composition is not null, 'victoryPoints', r.victory_points,
    'viewerId', (select id from app_private.members where room_id = r.id and user_id = auth.uid()),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nickname', m.nickname, 'points', m.points,
      'connected', m.last_seen > now() - interval '30 seconds') order by m.seat), '[]'::jsonb)
      from app_private.members m where m.room_id = r.id)))
  from app_private.rooms r where r.id = target;
$$;
create or replace function public.lobby_command_bodybuilder(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; r app_private.rooms%rowtype; me app_private.members%rowtype; comp jsonb; points jsonb; role text; amount integer; total integer:=0; wolves integer; mode text; candidates jsonb; planned integer;
begin
 perform app_private.assert_site_access();
 if action<>'settings' then return app_private.bodybuilder_response(public.lobby_command_wolfbound(action,payload),(payload->>'roomId')::uuid); end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found or me.id<>r.host_id or r.status<>'waiting' then raise exception '待機中の主催者だけが設定を変更できます。'; end if;
 if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が更新されました。最新の内容を確認してください。'; end if;
 planned:=r.planned_players;
 if payload?'plannedPlayers' then
  if payload->'plannedPlayers'='null'::jsonb then planned:=null;
  elsif jsonb_typeof(payload->'plannedPlayers') is distinct from 'number' or coalesce(payload->>'plannedPlayers','') !~ '^([5-9]|1[0-3])$' then raise exception '予定人数は5〜13人で設定してください。';
  else planned:=(payload->>'plannedPlayers')::integer;end if;
 end if;
 if coalesce(payload->>'discussionMinutes','') !~ '^[0-9]{1,2}$' or (payload->>'discussionMinutes')::integer not between 1 and 10 then raise exception '議論時間は1〜10分です。'; end if;
 mode:=coalesce(payload->>'compositionMode',case when nullif(payload->'composition','null'::jsonb)is null then 'standard'else 'custom'end);
 if mode not in('standard','custom','random')then raise exception '配役モードが不正です。';end if;
 candidates:=coalesce(payload->'randomCandidates',r.random_candidates);
 perform app_private.random_composition(5,candidates);
 comp:=case when mode='custom'then nullif(payload->'composition','null'::jsonb)else null end;
 if mode='custom'and comp is null then raise exception 'カスタム配役が必要です。';end if;
 if comp is not null then
  comp:='{"madman":0,"lover":0,"baker":0,"thief":0,"hunter":0,"doctor":0,"bodybuilder":0}'::jsonb||comp;
  if jsonb_typeof(comp)<>'object' or (select count(*) from jsonb_object_keys(comp))<>12 then raise exception '配役が不正です。'; end if;
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief','hunter','doctor','bodybuilder'] loop
   if jsonb_typeof(comp->role) is distinct from 'number' or coalesce(comp->>role,'') !~ '^[0-9]{1,2}$' then raise exception '配役は0以上の整数です。'; end if;
   amount:=(comp->>role)::integer;
   if amount>13 or (role in ('seer','medium','knight','madman','baker','thief','hunter','bodybuilder') and amount>1) then raise exception '能力職と怪盗は各0〜1人です。'; end if;
   if role='doctor'and amount>2 then raise exception'医者は0〜2人です。';end if;
   total:=total+amount;
  end loop;
  if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
  select coalesce(planned,count(*)::integer) into amount from app_private.members where room_id=r.id; wolves:=(comp->>'wolf')::integer;
  if amount<5 or total<>amount or wolves<1 or wolves>=total-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
 end if;
 points:=jsonb_build_object('bodybuilder',coalesce(payload->'victoryPoints'->'bodybuilder',r.victory_points->'bodybuilder','5'::jsonb),'doctor',coalesce(payload->'victoryPoints'->'doctor',r.victory_points->'doctor','5'::jsonb),'hunter',coalesce(payload->'victoryPoints'->'hunter',r.victory_points->'hunter','5'::jsonb),'thief',coalesce(payload->'victoryPoints'->'thief',r.victory_points->'thief','5'::jsonb))||coalesce(payload->'victoryPoints',r.victory_points);
 perform app_private.validate_victory_points(points);
 if payload?'consecutiveGuard'and jsonb_typeof(payload->'consecutiveGuard')is distinct from'boolean'then raise exception'連続護衛の設定が不正です。';end if;
 if payload?'wolfboundEnabled'and jsonb_typeof(payload->'wolfboundEnabled')is distinct from'boolean'then raise exception'狼憑きの設定が不正です。';end if;
 if coalesce((payload->>'wolfboundEnabled')::boolean,r.wolfbound_enabled)and coalesce((coalesce(comp,app_private.default_composition(coalesce(planned,(select count(*)::integer from app_private.members where room_id=r.id))))->>'villager')::integer,0)<1 then raise exception'狼憑きを使用するには村人が1人以上必要です。';end if;
 update app_private.rooms set planned_players=planned,composition_mode=mode,random_candidates=candidates,consecutive_guard=coalesce((payload->>'consecutiveGuard')::boolean,consecutive_guard),wolfbound_enabled=coalesce((payload->>'wolfboundEnabled')::boolean,wolfbound_enabled),discussion_minutes=(payload->>'discussionMinutes')::integer,composition=comp,victory_points=points,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 update public.room_updates set revision=r.revision where room_id=r.id;
 return app_private.bodybuilder_response(app_private.snapshot(r.id),r.id);
end; $$;
create or replace function app_private.keep_roster_composition() returns trigger
language plpgsql security definer set search_path='' as $$
declare rid uuid; n integer;
begin
 if tg_op='DELETE' then rid:=old.room_id;else rid:=new.room_id;end if;
 select count(*)::integer into n from app_private.members where room_id=rid;
 update app_private.rooms set composition=app_private.roster_composition(composition,n)
 where id=rid and planned_players is null and status='waiting' and composition_mode='custom' and composition is not null;
 if tg_op='DELETE' then return old;else return new;end if;
end;$$;
create or replace function app_private.keep_removed_roster_settings() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.status='waiting' and new.status='playing' and new.planned_players is not null and new.planned_players<>(select count(*) from app_private.members where room_id=new.id) then raise exception '予定人数と参加人数が違います。予定人数を変更してから開始してください。';end if;
 -- Legacy membership_command clears composition after a removal; retain it in custom mode.
 -- An explicit switch to standard/random changes composition_mode and remains allowed.
 if old.status='waiting' and new.status='waiting' and old.composition_mode='custom' and new.composition_mode='custom' and old.composition is not null and new.composition is null then
  new.composition:=case when new.planned_players is not null then old.composition else app_private.roster_composition(old.composition,(select count(*)::integer from app_private.members where room_id=old.id))end;
 end if;
 return new;
end;$$;

drop trigger if exists keep_roster_composition on app_private.members;
create trigger keep_roster_composition after insert or delete on app_private.members for each row execute function app_private.keep_roster_composition();
drop trigger if exists keep_removed_roster_settings on app_private.rooms;
create trigger keep_removed_roster_settings before update on app_private.rooms for each row execute function app_private.keep_removed_roster_settings();
commit;
