-- Realtime de comentarios de sala (WAT-145 / decisión en docs/decisions/realtime-comments.md).
-- La web se suscribe a los INSERT de room_comments; la escritura sigue siendo solo del backend.

-- Sólo se exponen las columnas del contrato público (ver RoomComment en la web):
-- author_id y client_request_id son internas y no deben ser legibles por
-- authenticated, ni por una consulta directa ni por el payload de Realtime.
grant select (id, room_id, body, created_at) on table public.room_comments to authenticated;

create policy room_comments_select_authenticated
  on public.room_comments
  for select
  to authenticated
  using (true);

alter publication supabase_realtime add table public.room_comments;