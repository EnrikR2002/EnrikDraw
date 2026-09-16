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
