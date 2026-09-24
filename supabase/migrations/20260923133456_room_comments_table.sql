create table room_comments (
                               id uuid primary key default gen_random_uuid(),
                               room_id uuid not null references rooms(id),
                               author_id uuid not null references auth.users(id),
                               body text not null,
                               client_request_id uuid not null,
                               created_at timestamptz not null default now(),
                               constraint room_comments_author_client_request_id_key unique (author_id, client_request_id)
);

create index room_comments_room_id_created_at_id_idx
    on room_comments (room_id, created_at, id);

alter table room_comments enable row level security;

revoke all privileges on table public.room_comments from anon, authenticated;

grant all privileges on table public.room_comments to service_role;