-- EnrikDraw database setup.
-- Run this once in the Supabase dashboard: SQL Editor > New query > Run.

create extension if not exists "pgcrypto";

create table if not exists public.drawings (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default 'Untitled',
  -- The canonical Excalidraw document, exactly as a .excalidraw file:
  -- {"type":"excalidraw","version":2,"source":...,"elements":[...],
  --  "appState":{...},"files":{...}}
  -- It is null until the first autosave runs.
  scene      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- /manage lists the newest drawing first.
create index if not exists drawings_updated_at_idx
  on public.drawings (updated_at desc);

-- Row level security is on, and there are deliberately no policies.
--
-- The app reaches Postgres only through Next.js route handlers using the
-- service role key, which bypasses row level security. With RLS on and no
-- policies, the anon and authenticated keys can read and write nothing, so a
-- leaked public key gives away no drawings.
alter table public.drawings enable row level security;
revoke all on public.drawings from anon, authenticated;
grant select, insert, update, delete on public.drawings to service_role;

-- Revisions cover editor, manager and agent writes, including archive/restore.
-- Run this section on an existing install before deploying the new app.
alter table public.drawings
  add column if not exists revision uuid not null default gen_random_uuid(),
  add column if not exists deleted_at timestamptz,
  add column if not exists creation_fingerprint text;

create or replace function public.bump_drawing_revision()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.revision := gen_random_uuid();
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace trigger drawings_revision_before_update
  before update on public.drawings
  for each row execute function public.bump_drawing_revision();

-- A durable reservation keeps concurrent requests from appending twice.
create table if not exists public.notion_embeds (
  drawing_id uuid not null references public.drawings (id) on delete cascade,
  page_id uuid not null,
  block_id uuid,
  created_at timestamptz not null default now(),
  primary key (drawing_id, page_id)
);
alter table public.notion_embeds enable row level security;
revoke all on public.notion_embeds from anon, authenticated;
grant select, insert, update, delete on public.notion_embeds to service_role;

-- Temporary parts for saves that exceed one HTTP request. Keep at most seven
-- slots per drawing, even when several tabs start uploads or a tab closes.
create table if not exists public.drawing_save_parts (
  drawing_id uuid not null references public.drawings (id) on delete cascade,
  part integer not null check (part between 0 and 6),
  upload_id uuid not null,
  revision uuid not null,
  chunk text not null check (octet_length(chunk) between 1 and 4000000),
  expires_at timestamptz not null,
  primary key (drawing_id, part)
);
create index if not exists drawing_save_parts_expiry_idx on public.drawing_save_parts (expires_at);
alter table public.drawing_save_parts enable row level security;
revoke all on public.drawing_save_parts from anon, authenticated;
grant select, insert, update, delete on public.drawing_save_parts to service_role;

-- Part zero starts an upload. Serialize staging with drawing writes so a
-- displaced upload cannot overwrite the current upload's parts.
create or replace function public.stage_drawing_save_part(
  p_drawing_id uuid, p_revision uuid, p_upload_id uuid, p_part integer, p_chunk text
)
returns text
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform 1 from public.drawings
    where id = p_drawing_id and revision = p_revision and deleted_at is null
    for no key update;
  if not found then
    return 'revision_conflict';
  end if;

  if p_part = 0 then
    delete from public.drawing_save_parts
      where drawing_id = p_drawing_id and (upload_id <> p_upload_id or revision <> p_revision);
  elsif not exists (
    select 1 from public.drawing_save_parts
      where drawing_id = p_drawing_id and part = 0 and upload_id = p_upload_id
        and revision = p_revision and expires_at > clock_timestamp()
  ) then
    return 'upload_incomplete';
  end if;

  insert into public.drawing_save_parts (drawing_id, part, upload_id, revision, chunk, expires_at)
    values (p_drawing_id, p_part, p_upload_id, p_revision, p_chunk, clock_timestamp() + interval '15 minutes')
    on conflict (drawing_id, part) do update set
      upload_id = excluded.upload_id, revision = excluded.revision,
      chunk = excluded.chunk, expires_at = excluded.expires_at;
  return 'staged';
end;
$$;
revoke all on function public.stage_drawing_save_part(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.stage_drawing_save_part(uuid, uuid, uuid, integer, text) to service_role;
