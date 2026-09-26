-- Realtime de comentarios de sala (WAT-145 / decisión en docs/decisions/realtime-comments.md).
-- La web se suscribe a los INSERT de room_comments; la escritura sigue siendo solo del backend.

grant select on table public.room_comments to authenticated;

create policy room_comments_select_authenticated
  on public.room_comments
  for select
                 to authenticated
                 using (true);

alter publication supabase_realtime add table public.room_comments;