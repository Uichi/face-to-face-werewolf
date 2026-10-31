-- Apply after 028. Fix empty responses when first night ends without bread.
-- Replaces only response formatting, not actions, phase rules, or saved game data.
begin;
create or replace function app_private.bread_choice_response(result jsonb,room_id uuid)returns jsonb
language plpgsql security definer set search_path=''as $$
declare g jsonb;delivery jsonb;delivered boolean:=false;
begin
 select games.state into g from app_private.games games where games.room_id=bread_choice_response.room_id;
 result:=jsonb_set(result,'{room,breadChoices}','true'::jsonb,true);
 if result->'game'is null or g is null then return result;end if;
 delivery:=g->'breadDelivery';
 -- SQL NULL must never reach jsonb_set: that would null the entire response.
 delivered:=coalesce(jsonb_typeof(delivery)='object'and
   (g->>'phase'='morning'or(g->>'phase'='discussion'and(g->>'day')::integer=1 and delivery->>'day'='0')),false);
 result:=jsonb_set(result,'{game,public,breadDelivery}',coalesce(delivery,'null'::jsonb),true);
 result:=jsonb_set(result,'{game,public,breadDelivered}',to_jsonb(delivered),true);
 result:=jsonb_set(result,'{game,public,publicLog}',coalesce(g->'publicLog','[]'::jsonb),true);
 return result;
end;$$;
revoke all on function app_private.bread_choice_response(jsonb,uuid)from public,anon,authenticated;
commit;
