-- ============================================================
-- Migration 002 — personal tasks with categories
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run.
-- ============================================================

-- Category label for organising personal tasks
alter table public.cloud_tasks add column if not exists category text;

-- Allow an 'open' status for self-created tasks
alter table public.cloud_tasks drop constraint if exists cloud_tasks_status_check;
alter table public.cloud_tasks add constraint cloud_tasks_status_check
  check (status in ('sent','seen','accepted','in_progress','done','declined','open'));

-- Let people delete tasks they created (e.g. their own personal tasks)
drop policy if exists "tasks_delete_owner" on public.cloud_tasks;
create policy "tasks_delete_owner" on public.cloud_tasks
  for delete to authenticated using (owner_id = auth.uid());
