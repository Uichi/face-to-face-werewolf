-- Separate from the portable database tests, which do not run the Realtime service.
do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_updates') then
    alter publication supabase_realtime add table public.room_updates;
  end if;
end;
$$;
