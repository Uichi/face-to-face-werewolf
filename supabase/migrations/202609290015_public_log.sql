-- Persist a chronological, public-only game log. Apply after migration 014.
-- Rerunnable. Existing games start with an empty log and continue normally.
begin;

create or replace function public.game_command_public_log(action text, payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  target_room uuid; before_state jsonb; after_state jsonb; result jsonb; events jsonb;
  event jsonb; event_id text; new_revision bigint; elimination jsonb;
begin
  target_room:=(payload->>'roomId')::uuid;
  select state into before_state from app_private.games where room_id=target_room;
  result:=public.game_command_first_day(action,payload);
  if coalesce(result->>'ok','true')<>'true' then return result; end if;
  select state into after_state from app_private.games where room_id=target_room;
  if after_state is null then return result; end if;
  events:=coalesce(after_state->'publicLog','[]'::jsonb);

  if after_state->'lastElimination' is distinct from before_state->'lastElimination' then
    elimination:=after_state->'lastElimination';
    if elimination->>'cause' in ('execution','attack') then
      event_id:=(elimination->>'cause')||'-'||(after_state->>'phaseId');
      event:=jsonb_build_object(
        'id',event_id,'day',(elimination->>'day')::integer,
        'kind',case when elimination->>'cause'='execution' then 'execution' else 'attack' end,
        'playerId',elimination->'playerId',
        'followedIds',coalesce(elimination->'followedIds','[]'::jsonb)
      );
    end if;
  elsif before_state->>'phase' in ('vote','runoff') and after_state->>'phase'='execution'
    and after_state->'voteResult'->>'executedId' is null then
    event_id:='no-execution-'||(after_state->>'phaseId');
    event:=jsonb_build_object('id',event_id,'day',(after_state->>'day')::integer,'kind','noExecution');
  elsif before_state->>'phase'='night' and after_state->>'phase'='morning'
    and after_state->>'victimId' is null then
    event_id:='no-victim-'||(after_state->>'phaseId');
    event:=jsonb_build_object('id',event_id,'day',(before_state->>'day')::integer,'kind','noVictim');
  end if;

  if event is not null and not exists(select 1 from jsonb_array_elements(events) value where value->>'id'=event_id) then
    events:=events||jsonb_build_array(event);
    after_state:=jsonb_set(after_state,'{publicLog}',events,true);
    update app_private.games set state=after_state where room_id=target_room;
    update app_private.rooms set revision=revision+1,updated_at=now() where id=target_room returning revision into new_revision;
    update public.room_updates set revision=new_revision where room_id=target_room;
    result:=jsonb_set(result,'{game,public,publicLog}',events,true);
    result:=jsonb_set(result,'{room,revision}',to_jsonb(new_revision),true);
  else
    result:=jsonb_set(result,'{game,public,publicLog}',events,true);
  end if;
  return result;
end;
$$;

revoke all on function public.game_command_public_log(text,jsonb) from public,anon;
grant execute on function public.game_command_public_log(text,jsonb) to authenticated;
commit;
