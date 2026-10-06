-- Apply after 022; no existing SQL or data is deleted.
begin;
alter table app_private.rooms add column if not exists composition_mode text not null default 'standard';
alter table app_private.rooms add column if not exists random_candidates jsonb not null default '["seer","medium","knight","madman","lover","baker","thief","hunter"]'::jsonb;
update app_private.rooms set composition_mode='custom' where composition is not null and composition_mode='standard';
create or replace function app_private.random_composition(n integer,candidates jsonb) returns jsonb
language plpgsql volatile set search_path='' as $$
declare comp jsonb; options jsonb:='[]'; mask integer; i integer; role text; amount integer; villagers integer; wolves integer; bytes bytea; draw bigint; bound bigint; size integer;
begin
 if n not between 5 and 13 or jsonb_typeof(candidates) is distinct from 'array' then raise exception '人数または抽選候補が不正です。';end if;
 if exists(select 1 from jsonb_array_elements(candidates)v where jsonb_typeof(v)<>'string' or v#>>'{}' not in('seer','medium','knight','madman','lover','baker','thief','hunter')) or (select count(distinct v)from jsonb_array_elements(candidates)v)<>jsonb_array_length(candidates) then raise exception '抽選候補が不正です。';end if;
 wolves:=(app_private.default_composition(n)->>'wolf')::integer;
 for mask in 0..(2^jsonb_array_length(candidates))::integer-1 loop
 comp:=jsonb_build_object('villager',0,'wolf',wolves,'seer',0,'medium',0,'knight',0,'madman',0,'lover',0,'baker',0,'thief',0,'hunter',0);villagers:=n-wolves;
 for i in 0..jsonb_array_length(candidates)-1 loop
 if (mask & (1<<i))<>0 then role:=candidates->>i;amount:=case when role='lover'then 2 else 1 end;villagers:=villagers-amount;comp:=jsonb_set(comp,array[role],to_jsonb(amount));end if;
 end loop;
 if villagers>=1 then options:=options||jsonb_build_array(jsonb_set(comp,'{villager}',to_jsonb(villagers)));end if;
 end loop;
 size:=jsonb_array_length(options);bound:=4294967296-(4294967296 % size);
 loop bytes:=extensions.gen_random_bytes(4);draw:=get_byte(bytes,0)::bigint*16777216+get_byte(bytes,1)::bigint*65536+get_byte(bytes,2)::bigint*256+get_byte(bytes,3);exit when draw<bound;end loop;
 return options->(draw % size)::integer;
end;$$;

create or replace function app_private.snapshot(target uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'room', jsonb_build_object(
    'id', r.id, 'code', r.code, 'hostId', r.host_id, 'status', r.status,
    'revision', r.revision, 'discussionMinutes', r.discussion_minutes,
    'randomComposition',true,'compositionMode',r.composition_mode,'randomCandidates',r.random_candidates,'fixedWolves',(app_private.default_composition((select count(*)::integer from app_private.members where room_id=r.id))->'wolf'),
    'composition', case when r.composition_mode='random' then null else coalesce('{"madman":0,"lover":0}'::jsonb || r.composition, app_private.default_composition((select count(*)::integer from app_private.members where room_id = r.id))) end,
    'loverRole',true,'customComposition', r.composition is not null, 'victoryPoints', r.victory_points,
    'viewerId', (select id from app_private.members where room_id = r.id and user_id = auth.uid()),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nickname', m.nickname, 'points', m.points,
      'connected', m.last_seen > now() - interval '30 seconds') order by m.seat), '[]'::jsonb)
      from app_private.members m where m.room_id = r.id)))
  from app_private.rooms r where r.id = target;
$$;
create or replace function app_private.random_response(result jsonb,target_room uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare r app_private.rooms%rowtype;g jsonb;
begin
 target_room:=coalesce(target_room,(result#>>'{room,id}')::uuid);select * into r from app_private.rooms where id=target_room;
 result:=app_private.hunter_response(result,target_room);
 if r.composition_mode='random'then result:=jsonb_set(result,'{room,composition}','null'::jsonb);end if;
 if result->'game' is not null and result->'game'<>'null'::jsonb then
 select state into g from app_private.games where room_id=target_room;
 if g->>'compositionMode'='random'then
 result:=jsonb_set(result,'{game,public}',result#>'{game,public}'||jsonb_build_object('compositionMode','random','randomCandidates',g->'randomCandidates','fixedWolves',g->'initialComposition'->'wolf','composition',case when g->>'phase'='finished'then g->'initialComposition'else null end));
 end if;
 end if;
 return result;
end;$$;

create or replace function public.lobby_command_random(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; r app_private.rooms%rowtype; me app_private.members%rowtype; comp jsonb; points jsonb; role text; amount integer; total integer:=0; wolves integer; mode text; candidates jsonb;
begin
 perform app_private.assert_site_access();
 if action<>'settings' then return app_private.random_response(public.lobby_command_wolfbound(action,payload),(payload->>'roomId')::uuid); end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found or me.id<>r.host_id or r.status<>'waiting' then raise exception '待機中の主催者だけが設定を変更できます。'; end if;
 if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が更新されました。最新の内容を確認してください。'; end if;
 if coalesce(payload->>'discussionMinutes','') !~ '^[0-9]{1,2}$' or (payload->>'discussionMinutes')::integer not between 1 and 10 then raise exception '議論時間は1〜10分です。'; end if;
 mode:=coalesce(payload->>'compositionMode',case when nullif(payload->'composition','null'::jsonb)is null then 'standard'else 'custom'end);
 if mode not in('standard','custom','random')then raise exception '配役モードが不正です。';end if;
 candidates:=coalesce(payload->'randomCandidates',r.random_candidates);
 perform app_private.random_composition(5,candidates);
 comp:=case when mode='custom'then nullif(payload->'composition','null'::jsonb)else null end;
 if mode='custom'and comp is null then raise exception 'カスタム配役が必要です。';end if;
 if comp is not null then
  comp:='{"madman":0,"lover":0,"baker":0,"thief":0,"hunter":0}'::jsonb||comp;
  if jsonb_typeof(comp)<>'object' or (select count(*) from jsonb_object_keys(comp))<>10 then raise exception '配役が不正です。'; end if;
  foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief','hunter'] loop
   if jsonb_typeof(comp->role) is distinct from 'number' or coalesce(comp->>role,'') !~ '^[0-9]{1,2}$' then raise exception '配役は0以上の整数です。'; end if;
   amount:=(comp->>role)::integer;
   if amount>13 or (role in ('seer','medium','knight','madman','baker','thief','hunter') and amount>1) then raise exception '能力職と怪盗は各0〜1人です。'; end if;
   total:=total+amount;
  end loop;
  if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
  select count(*) into amount from app_private.members where room_id=r.id; wolves:=(comp->>'wolf')::integer;
  if amount<5 or total<>amount or wolves<1 or wolves>=total-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
 end if;
 points:=jsonb_build_object('hunter',coalesce(payload->'victoryPoints'->'hunter',r.victory_points->'hunter','5'::jsonb),'thief',coalesce(payload->'victoryPoints'->'thief',r.victory_points->'thief','5'::jsonb))||coalesce(payload->'victoryPoints',r.victory_points);
 perform app_private.validate_victory_points(points);
 if payload?'consecutiveGuard'and jsonb_typeof(payload->'consecutiveGuard')is distinct from'boolean'then raise exception'連続護衛の設定が不正です。';end if;
 if payload?'wolfboundEnabled'and jsonb_typeof(payload->'wolfboundEnabled')is distinct from'boolean'then raise exception'狼憑きの設定が不正です。';end if;
 if coalesce((payload->>'wolfboundEnabled')::boolean,r.wolfbound_enabled)and coalesce((coalesce(comp,app_private.default_composition((select count(*)::integer from app_private.members where room_id=r.id)))->>'villager')::integer,0)<1 then raise exception'狼憑きを使用するには村人が1人以上必要です。';end if;
 update app_private.rooms set composition_mode=mode,random_candidates=candidates,consecutive_guard=coalesce((payload->>'consecutiveGuard')::boolean,consecutive_guard),wolfbound_enabled=coalesce((payload->>'wolfboundEnabled')::boolean,wolfbound_enabled),discussion_minutes=(payload->>'discussionMinutes')::integer,composition=comp,victory_points=points,revision=revision+1,updated_at=now() where id=r.id returning * into r;
 update public.room_updates set revision=r.revision where room_id=r.id;
 return app_private.random_response(app_private.snapshot(r.id),r.id);
end; $$;
create or replace function public.game_command_random(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
 r app_private.rooms%rowtype; me app_private.members%rowtype; g jsonb; original jsonb; p jsonb; target jsonb;
 at_ms bigint; comp jsonb; role text; pool text[]:=array[]::text[]; players jsonb:='[]'::jsonb;
 member record; n integer; total integer:=0; wolves integer; idx integer:=0; phase text; winner text; shown text;candidate uuid;chosen text;previous_elimination jsonb;
 receipt text; fingerprint jsonb; created boolean:=false; start_request text;
begin
 perform app_private.assert_site_access();
 if auth.uid() is null then raise exception 'ログインが必要です。'; end if;
 if action is null or action not in ('start','get','select','confirm','next','startVote','extend','remove','rematch','cancelShot') then raise exception '操作が不正です。'; end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception '操作が不正です。'; end if;
 -- Every operation locks the room first, matching the lobby lock order.
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 if not found then raise exception '部屋が見つからないか、有効期限が切れています。'; end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then raise exception 'この部屋に参加していません。'; end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if not app_private.allow_attempt('game',240,interval '1 minute') then return jsonb_build_object('ok',false,'message','操作が多いため、少し待ってください。'); end if;
 select state into g from app_private.games where room_id=r.id;
 update app_private.members set last_seen=now()where id=me.id;
 if exists(select 1 from app_private.members where id=r.host_id and last_seen<=now()-interval'60 seconds')then select id into candidate from app_private.members where room_id=r.id and last_seen>now()-interval'30 seconds'order by seat limit 1;if candidate is not null then update app_private.rooms set host_id=candidate where id=r.id returning*into r;end if;end if;
 original:=g;
 if action='start' then
   if r.host_id<>me.id then raise exception '主催者のみ開始できます。'; end if;
   start_request:=(payload->>'requestId')::uuid::text;
   if start_request is null then raise exception '操作IDが必要です。'; end if;
   if r.status<>'waiting' then
     if g->>'startRequest'=start_request then
       return app_private.random_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.hunter_view(g,me.id::text),'serverNow',at_ms),r.id);
     end if;
     raise exception 'すでにゲームが始まっています。';
   end if;
   if (payload->>'revision')::bigint is distinct from r.revision then raise exception '参加者や設定が変わりました。内容を確認してもう一度開始してください。'; end if;
   select count(*) into n from app_private.members where room_id=r.id;
   if n not between 5 and 13 then raise exception '開始には5〜13人必要です。'; end if;
   comp:='{"madman":0,"lover":0,"baker":0,"thief":0,"hunter":0}'::jsonb || case when r.composition_mode='random'then app_private.random_composition(n,r.random_candidates)else coalesce(r.composition,app_private.default_composition(n))end;
   foreach role in array array['villager','wolf','seer','medium','knight','madman','lover','baker','thief','hunter'] loop
     if jsonb_typeof(comp->role) is distinct from 'number' or comp->>role !~ '^[0-9]{1,2}$' then raise exception '配役が不正です。'; end if;
     if (comp->>role)::integer>13 or (role in ('seer','medium','knight','madman','baker','thief','hunter') and (comp->>role)::integer>1) then raise exception '配役が不正です。'; end if;
     total:=total+(comp->>role)::integer;
     pool:=pool||array_fill(role,array[(comp->>role)::integer]);
   end loop;
   if (comp->>'lover')::integer not in (0,2) then raise exception '恋人は0人か2人で設定してください。'; end if;
   wolves:=(comp->>'wolf')::integer;
   if total<>n or wolves<1 or wolves>=n-wolves then raise exception '配役合計と人狼の人数を確認してください。'; end if;
   select array_agg(value order by gen_random_uuid()) into pool from unnest(pool) value;
   for member in select id from app_private.members where room_id=r.id order by seat loop
     idx:=idx+1; players:=players||jsonb_build_array(jsonb_build_object('id',member.id,'role',pool[idx],'initialRole',pool[idx],'apparentRole',pool[idx],'alive',true));
   end loop;
   g:=jsonb_build_object('id',gen_random_uuid(),'startRequest',start_request,'hostId',r.host_id,'players',players,'phase','roles','phaseId',1,'day',1,
    'discussionMs',r.discussion_minutes*60000,'deadline',null,'selections','{}'::jsonb,'confirmed','[]'::jsonb,'runoffIds','[]'::jsonb,
    'voteResult',null,'victimId',null,'winner',null,'secrets','[]'::jsonb,'removals','[]'::jsonb,'receipts','{}'::jsonb);
   g:=g||jsonb_build_object('compositionMode',r.composition_mode,'randomCandidates',r.random_candidates,'initialComposition',comp);
   g:=g||jsonb_build_object('scoring',jsonb_build_object('victoryPoints',r.victory_points,'stats','{}'::jsonb));
   g:=g||jsonb_build_object('consecutiveGuard',r.consecutive_guard,'lastGuardTargets','{}'::jsonb,'attackStrengths','{}'::jsonb,'publicLog','[]'::jsonb,'breadDelivery',null);
   if r.wolfbound_enabled then
    if (comp->>'villager')::integer<1 then raise exception'狼憑きを使用するには村人が1人以上必要です。';end if;
    if(get_byte(extensions.gen_random_bytes(1),0)&1)=1 then select q->>'id'into chosen from jsonb_array_elements(g->'players')q where q->>'role'='villager'order by gen_random_uuid()limit 1;g:=jsonb_set(g,'{players}',(select jsonb_agg(case when q->>'id'=chosen then q||'{"wolfbound":true,"initialWolfbound":true}'::jsonb else q end)from jsonb_array_elements(g->'players')q));end if;
   end if;
   update app_private.rooms set status='playing' where id=r.id;
   created:=true;
 elsif r.status='waiting' then
   if action<>'get' then raise exception '待機室に戻っています。'; end if;
   return app_private.random_response(app_private.snapshot(r.id)||jsonb_build_object('game',null,'serverNow',at_ms),r.id);
 else
   if g is null then raise exception '試合が見つかりません。'; end if;
   g:=g||jsonb_build_object('hostId',r.host_id);
   if action<>'get' then
     if payload->>'gameId' is distinct from g->>'id' then raise exception '別の試合の操作です。画面を更新してください。'; end if;
     if payload->>'requestId' is null then raise exception '操作IDが必要です。'; end if;
     receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;
     fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId','targetId',payload->'targetId','strength',payload->'strength');
     if g->'receipts' ? receipt then
       if g->'receipts'->receipt<>fingerprint then raise exception '同じ操作IDの内容が異なります。'; end if;
       return app_private.random_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.hunter_view(g,me.id::text),'serverNow',at_ms),r.id);
     end if;
   end if;
   -- A server clock check on every read also recovers a missed realtime notification.
   g:=app_private.hunter_settle(g,at_ms);
   if action<>'get' then
     if (payload->>'phaseId')::integer is distinct from (g->>'phaseId')::integer then
       -- Keep an elapsed clock transition even when the arriving operation is stale.
       g:=app_private.score_award(r.id,g);
       update app_private.games set state=g where room_id=r.id;
       update app_private.rooms set revision=revision+1,updated_at=now(),status=case when g->>'phase'='finished' then 'finished' else 'playing' end where id=r.id returning * into r;
       update public.room_updates set revision=r.revision where room_id=r.id;
       return jsonb_build_object('ok',false,'message','次の段階に進みました。最新の画面で操作してください。');
     end if;
     phase:=g->>'phase';
     select value into p from jsonb_array_elements(g->'players') where value->>'id'=me.id::text;
     if action in ('next','startVote','extend','remove','rematch','cancelShot') then
       if me.id<>r.host_id then raise exception '主催者のみ操作できます。'; end if;
     elsif phase='hunter'and g->'hunterPending'->>'actorId'<>me.id::text then raise exception'狩人本人だけが発砲できます。';
     elsif not(p->>'alive')::boolean and not(phase='hunter'and g->'hunterPending'->>'actorId'=me.id::text)then raise exception '脱落者は操作できません。'; end if;
     if phase='finished' and action<>'rematch' then raise exception '試合は終了しています。'; end if;
     if action='rematch' then
       if phase<>'finished' then raise exception '終了後に再戦できます。'; end if;
       delete from app_private.games where room_id=r.id;
       update app_private.rooms set status='waiting',revision=revision+1,updated_at=now() where id=r.id returning * into r;
       update public.room_updates set revision=r.revision where room_id=r.id;
       return app_private.random_response(app_private.snapshot(r.id)||jsonb_build_object('game',null,'serverNow',at_ms),r.id);
     elsif action='select' then
       if phase not in ('roles','firstNight','vote','runoff','night','hunter') then raise exception '選択する段階ではありません。'; end if;
       if g->'confirmed' ? me.id::text then raise exception '確定済みです。'; end if;
       shown:=case when coalesce((p->>'decoy')::boolean,false)then p->>'apparentRole'else p->>'role'end;
       if payload->>'targetId'is null then raise exception'対象が不正です。';end if;
       if shown='baker'and phase in('firstNight','night')then
        if payload->>'targetId'not in('shokupan','croissant','melonpan','currypan','anpan','surprise')then raise exception'パンの種類が不正です。';end if;
       else
        select value into target from jsonb_array_elements(g->'players')where value->>'id'=payload->>'targetId'and(value->>'alive')::boolean;
        if payload->>'targetId'='__no_execution__'and(g->>'day')::integer=1 and phase in('vote','runoff')then null;
        elsif target is null or target->>'id'=me.id::text then raise exception'対象が不正です。';end if;
        if phase='roles'and shown<>'thief'or phase='firstNight'then raise exception'選択する能力がありません。';end if;
        if phase='runoff'and not(g->'runoffIds')?(payload->>'targetId')then raise exception'決選候補ではありません。';end if;
        if phase='night'then
         if shown not in('wolf','seer','knight')then raise exception'選択する能力がありません。';end if;
         if shown='knight'and not coalesce((g->>'consecutiveGuard')::boolean,true)and g->'lastGuardTargets'->>me.id::text=payload->>'targetId'then raise exception'前の夜と同じ人は続けて護衛できません。';end if;
         if shown='wolf'then
          if coalesce(payload->>'strength','')!~'^[123]$'then raise exception'襲撃の希望度を選んでください。';end if;
          g:=jsonb_set(g,'{attackStrengths}',coalesce(g->'attackStrengths','{}'::jsonb),true);g:=jsonb_set(g,array['attackStrengths',me.id::text],payload->'strength');
         end if;
        end if;
       end if;
       g:=jsonb_set(g,array['selections',me.id::text],to_jsonb(payload->>'targetId'));
     elsif action='confirm' then
       shown:=case when coalesce((p->>'decoy')::boolean,false)then p->>'apparentRole'else p->>'role'end;
       if phase not in('roles','firstNight','vote','runoff','night','hunter')then raise exception'結果は主催者が次へ進めます。';end if;
       if(phase in('vote','runoff','hunter')or phase='roles'and shown='thief'or phase='night'and shown in('wolf','seer','knight','baker')or phase='firstNight'and shown='baker')and not(g->'selections')?me.id::text then raise exception'先に対象を選んでください。';end if;
       if phase='hunter'then g:=app_private.hunter_shot(g,at_ms);
       elsif not(g->'confirmed')?me.id::text then g:=jsonb_set(g,'{confirmed}',g->'confirmed'||jsonb_build_array(me.id));end if;
     elsif action='cancelShot'then
       if phase<>'hunter'or at_ms<(g->>'deadline')::bigint then raise exception'発砲の期限後だけ中止できます。';end if;g:=app_private.hunter_shot(g,at_ms,true);
     elsif action='next'then
       if phase='execution'then g:=app_private.game_enter(g||'{"victimId":null}'::jsonb,'night',at_ms);
       elsif phase='morning'then g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,'discussion',at_ms);
       else raise exception'結果画面ではありません。';end if;
     elsif action='startVote' then
       if phase<>'discussion' then raise exception '議論中ではありません。'; end if;
       g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,'vote',at_ms);
     elsif action='extend' then
       if phase not in ('discussion','vote','runoff','night','hunter') then raise exception '延長できる段階ではありません。'; end if;
       g:=jsonb_set(g,'{deadline}',to_jsonb(greatest(at_ms,(g->>'deadline')::bigint)+60000));
     elsif action='remove' then
       previous_elimination:=g->'lastElimination';
       g:=app_private.game_kill(g,payload->>'targetId','disconnect');
       g:=jsonb_set(g,'{removals}',(g->'removals')||(select jsonb_agg(jsonb_build_object('playerId',id,'day',g->'day')) from jsonb_array_elements_text(jsonb_build_array(payload->>'targetId')||coalesce(g->'lastElimination'->'followedIds','[]'::jsonb)) id));
       winner:=app_private.game_winner(g);
       if phase='hunter'then
        g:=jsonb_set(g,'{lastElimination}',coalesce(previous_elimination,'null'::jsonb),true);
        if not exists(select 1 from jsonb_array_elements(g->'players')q where(q->>'alive')::boolean)then g:=app_private.hunter_shot(g,at_ms,true);
        else
         if not exists(select 1 from jsonb_array_elements(g->'players')q where q->>'id'=g->'selections'->>(g->'hunterPending'->>'actorId')and(q->>'alive')::boolean)then g:=jsonb_set(g,'{selections}',(g->'selections')-(g->'hunterPending'->>'actorId'));end if;
         g:=jsonb_set(g,'{phaseId}',to_jsonb((g->>'phaseId')::integer+1));
        end if;
       elsif winner is not null then g:=app_private.game_enter(g||jsonb_build_object('winner',winner),'finished',at_ms);
       elsif phase in ('vote','runoff','night') then
         g:=app_private.game_enter(g||'{"voteResult":null}'::jsonb,case when phase='night' then 'night' else 'vote' end,at_ms);
       else
         g:=g||jsonb_build_object('phaseId',(g->>'phaseId')::integer+1,'confirmed',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(g->'confirmed') confirmed where exists(select 1 from jsonb_array_elements(g->'players') living where living->>'id'=confirmed.value#>>'{}' and (living->>'alive')::boolean)));
       end if;
     end if;
     if action='remove'and phase='roles'then
      for chosen in select key from jsonb_each_text(g->'selections')c where not exists(select 1 from jsonb_array_elements(g->'players')q where q->>'id'=c.value and(q->>'alive')::boolean)loop g:=jsonb_set(g,'{selections}',(g->'selections')-chosen);g:=jsonb_set(g,'{confirmed}',(g->'confirmed')-chosen);end loop;
     end if;
     g:=jsonb_set(g,array['receipts',receipt],fingerprint);
     g:=app_private.hunter_settle(g,at_ms);
   end if;
 end if;
 g:=app_private.score_award(r.id,g);
 if g is distinct from original or created then
   insert into app_private.games values(r.id,g) on conflict(room_id) do update set state=excluded.state;
   update app_private.rooms set revision=revision+1,updated_at=now(),status=case when g->>'phase'='finished' then 'finished' else 'playing' end where id=r.id returning * into r;
   update public.room_updates set revision=r.revision where room_id=r.id;
 end if;
 return app_private.random_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.hunter_view(g,me.id::text),'serverNow',at_ms),r.id);
end;
$$;

revoke all on function app_private.random_composition(integer,jsonb),app_private.random_response(jsonb,uuid)from public,anon,authenticated;
revoke all on function public.game_command_random(text,jsonb),public.lobby_command_random(text,jsonb)from public,anon;
do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and (p.proname like 'game_command%'or p.proname like 'lobby_command%')and p.proname not in('game_command_random','lobby_command_random')loop execute format('revoke execute on function %s from public,anon,authenticated',f.signature);end loop;
end$$;
grant execute on function public.game_command_random(text,jsonb),public.lobby_command_random(text,jsonb)to authenticated;
commit;
