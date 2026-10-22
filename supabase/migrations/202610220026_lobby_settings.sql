-- Apply after 025. Preserve custom roles when the waiting-room roster changes.
begin;
create or replace function app_private.roster_composition(comp jsonb, n integer) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_set(comp,'{villager}',to_jsonb(greatest(0,n-(select coalesce(sum(value::integer),0)::integer from jsonb_each_text(comp) where key<>'villager'))))
$$;
create or replace function app_private.keep_roster_composition() returns trigger
language plpgsql security definer set search_path='' as $$
declare rid uuid; n integer;
begin
 if tg_op='DELETE' then rid:=old.room_id;else rid:=new.room_id;end if;
 select count(*)::integer into n from app_private.members where room_id=rid;
 update app_private.rooms set composition=app_private.roster_composition(composition,n)
 where id=rid and status='waiting' and composition_mode='custom' and composition is not null;
 if tg_op='DELETE' then return old;else return new;end if;
end;$$;
create or replace function app_private.keep_removed_roster_settings() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Legacy membership_command clears composition after a removal; retain it in custom mode.
 -- An explicit switch to standard/random changes composition_mode and remains allowed.
 if old.status='waiting' and new.status='waiting' and old.composition_mode='custom' and new.composition_mode='custom' and old.composition is not null and new.composition is null then
  new.composition:=app_private.roster_composition(old.composition,(select count(*)::integer from app_private.members where room_id=old.id));
 end if;
 return new;
end;$$;
drop trigger if exists keep_roster_composition on app_private.members;
create trigger keep_roster_composition after insert or delete on app_private.members for each row execute function app_private.keep_roster_composition();
drop trigger if exists keep_removed_roster_settings on app_private.rooms;
create trigger keep_removed_roster_settings before update on app_private.rooms for each row execute function app_private.keep_removed_roster_settings();
revoke all on function app_private.roster_composition(jsonb,integer),app_private.keep_roster_composition(),app_private.keep_removed_roster_settings() from public,anon,authenticated;
commit;
