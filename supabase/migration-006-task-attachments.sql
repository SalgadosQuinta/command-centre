-- command-centre — migration 006
-- Attachments (screenshots/images) on delegated tasks. Safe to re-run.
alter table public.cloud_tasks add column if not exists attachments jsonb not null default '[]';
