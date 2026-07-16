-- ============================================================
-- Migration 003 — archive people
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run.
-- ============================================================

alter table public.profiles add column if not exists archived boolean not null default false;
