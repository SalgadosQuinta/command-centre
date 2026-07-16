-- ============================================================
-- Migration 004 — cloud sync of personal GTD data
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run.
-- ============================================================

create table if not exists public.user_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz default now()
);
alter table public.user_state enable row level security;

drop policy if exists "state_select_own" on public.user_state;
create policy "state_select_own" on public.user_state
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "state_insert_own" on public.user_state;
create policy "state_insert_own" on public.user_state
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "state_update_own" on public.user_state;
create policy "state_update_own" on public.user_state
  for update to authenticated using (user_id = auth.uid());
