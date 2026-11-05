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
