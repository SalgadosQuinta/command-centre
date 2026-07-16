-- ============================================================
-- GTD Command Centre platform — Supabase setup
-- Run once in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run.
-- ============================================================

-- ---------- People ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  display_name text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid());

-- Auto-create a profile whenever a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Delegated tasks (Phase 2) ----------
create table if not exists public.cloud_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  assignee_id uuid not null references public.profiles(id),
  title text not null,
  notes text,
  due_date date,
  priority text not null default 'normal',
  status text not null default 'sent'
    check (status in ('sent','seen','accepted','in_progress','done','declined')),
  comments jsonb not null default '[]',
  local_ref text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);
alter table public.cloud_tasks enable row level security;

drop policy if exists "tasks_select_parties" on public.cloud_tasks;
create policy "tasks_select_parties" on public.cloud_tasks
  for select to authenticated
  using (owner_id = auth.uid() or assignee_id = auth.uid());

drop policy if exists "tasks_insert_owner" on public.cloud_tasks;
create policy "tasks_insert_owner" on public.cloud_tasks
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists "tasks_update_parties" on public.cloud_tasks;
create policy "tasks_update_parties" on public.cloud_tasks
  for update to authenticated
  using (owner_id = auth.uid() or assignee_id = auth.uid());

-- ---------- Money ledger (Phase 3) — append-only ----------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  ledger_owner_id uuid not null references public.profiles(id),  -- who funds the float
  person_id uuid not null references public.profiles(id),        -- who holds / spends it
  type text not null check (type in ('float','spend')),
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'USD',
  description text,
  task_id uuid references public.cloud_tasks(id),
  receipt_path text,
  correction_of uuid references public.transactions(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz default now()
);
alter table public.transactions enable row level security;

drop policy if exists "ledger_select_parties" on public.transactions;
create policy "ledger_select_parties" on public.transactions
  for select to authenticated
  using (ledger_owner_id = auth.uid() or person_id = auth.uid());

drop policy if exists "ledger_insert_parties" on public.transactions;
create policy "ledger_insert_parties" on public.transactions
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (ledger_owner_id = auth.uid() or person_id = auth.uid())
  );
-- Deliberately no update/delete policies: corrections are new rows
-- (type reversed, correction_of pointing at the original). History always adds up.

-- ---------- Receipt photos ----------
insert into storage.buckets (id, name, public)
values ('receipts','receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts_upload_own_folder" on storage.objects;
create policy "receipts_upload_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "receipts_read_signed_in" on storage.objects;
create policy "receipts_read_signed_in" on storage.objects
  for select to authenticated using (bucket_id = 'receipts');

-- Done. You should see: profiles, cloud_tasks, transactions under Tables,
-- and a private 'receipts' bucket under Storage.
