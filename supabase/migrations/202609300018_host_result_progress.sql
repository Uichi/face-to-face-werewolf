-- Let the host advance public execution and morning result screens.
-- Apply after 202609290017_thief_result.sql. Rerunnable.
begin;

create or replace function public.game_command_host_results(action text,payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 r app_private.rooms%rowtype; me app_private.members%rowtype; g jsonb; at_ms bigint;
 receipt text; fingerprint jsonb; result jsonb; next_phase text;
begin
 if action<>'next' then
  result:=public.game_command_thief(action,payload);
  if result->'game' is not null then result:=jsonb_set(result,'{game,public,resultConfirmation}','false'::jsonb,true);end if;
  return result;
 end if;
 perform app_private.assert_site_access();
 if auth.uid() is null then raise exception 'ログインが必要です。';end if;
 select * into r from app_private.rooms where id=(payload->>'roomId')::uuid and updated_at>now()-interval '24 hours' for update;
 if not found then raise exception '部屋が見つからないか、有効期限が切れています。';end if;
 select * into me from app_private.members where room_id=r.id and user_id=auth.uid();
 if not found then raise exception 'この部屋に参加していません。';end if;
 if me.id<>r.host_id then raise exception '主催者のみ操作できます。';end if;
 select state into g from app_private.games where room_id=r.id;
 if g is null or r.status<>'playing' then raise exception '試合が見つかりません。';end if;
 if payload->>'gameId'is distinct from g->>'id' or (payload->>'phaseId')::integer is distinct from(g->>'phaseId')::integer then raise exception '最新の画面で操作してください。';end if;
 if g->>'phase' not in('execution','morning')then raise exception '結果画面ではありません。';end if;
 receipt:=me.id::text||':'||(payload->>'requestId')::uuid::text;
 fingerprint:=jsonb_build_object('action',action,'phaseId',payload->'phaseId');
 if g->'receipts'?receipt then
  if g->'receipts'->receipt<>fingerprint then raise exception '同じ操作IDの内容が異なります。';end if;
 else
  at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  next_phase:=case when g->>'phase'='execution'then'night'else'discussion'end;
  if next_phase='night'then g:=g||'{"victimId":null}'::jsonb;else g:=g||'{"voteResult":null}'::jsonb;end if;
  g:=app_private.game_enter(g,next_phase,at_ms);
  g:=jsonb_set(g,array['receipts',receipt],fingerprint);
  update app_private.games set state=g where room_id=r.id;
  update app_private.rooms set revision=revision+1,updated_at=now()where id=r.id returning * into r;
  update public.room_updates set revision=r.revision where room_id=r.id;
 end if;
 at_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 result:=app_private.thief_response(app_private.snapshot(r.id)||jsonb_build_object('game',app_private.game_view(g,me.id::text),'serverNow',at_ms),r.id);
 return jsonb_set(result,'{game,public,resultConfirmation}','false'::jsonb,true);
end;$$;

revoke all on function public.game_command_host_results(text,jsonb)from public,anon;
grant execute on function public.game_command_host_results(text,jsonb)to authenticated;
commit;
