-- Run in the Supabase SQL editor (safe to re-run). Account mode needs this; guest join works without it.
--
-- Google sign-in itself is enabled in the dashboard (Authentication -> Providers -> Google).
-- This file creates the profiles table, RLS, and the new-user trigger.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Student',
  role text not null default 'user' check (role in ('owner', 'admin', 'user')),
  banned boolean not null default false,
  hat text not null default '',
  top text not null default '',
  accessory text not null default '',
  updated_at timestamptz not null default now()
);

-- Idempotent for projects that created the table from an older version of this file.
alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists body text not null default 'x';

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER so policies on profiles can look at profiles
-- without re-triggering RLS (which would recurse forever).
-- ---------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner');
$$;

create or replace function public.own_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.own_banned()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p.banned from public.profiles p where p.id = auth.uid();
$$;

revoke all on function public.is_owner() from public;
revoke all on function public.own_role() from public;
revoke all on function public.own_banned() from public;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.own_role() to authenticated;
grant execute on function public.own_banned() to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
--   * A user can read and update their own row, but cannot change their own
--     role or banned flag (with check pins both to their current values).
--   * Only an owner can read every row, and only an owner can change another
--     user's role / banned. (The Colyseus server uses the service-role key,
--     which bypasses RLS; it enforces assertCanModerate in roles.ts.)
-- ---------------------------------------------------------------------------
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "update own look" on public.profiles;
drop policy if exists "profiles select own" on public.profiles;
drop policy if exists "profiles select owner" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
drop policy if exists "profiles update owner" on public.profiles;

create policy "profiles select own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles select owner"
  on public.profiles for select
  to authenticated
  using (public.is_owner());

create policy "profiles update own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = public.own_role()
    and banned = public.own_banned()
  );

create policy "profiles update owner"
  on public.profiles for update
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Inserts only happen through the trigger below (SECURITY DEFINER), never from clients.

-- ---------------------------------------------------------------------------
-- Create a profile row for every new auth user (email/password and Google).
-- Google puts the real name in raw_user_meta_data as full_name / name.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(new.raw_user_meta_data->>'display_name', ''),
        nullif(new.raw_user_meta_data->>'full_name', ''),
        nullif(new.raw_user_meta_data->>'name', ''),
        nullif(split_part(new.email, '@', 1), ''),
        'Student'
      ),
      24
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for auth users that signed up before the trigger existed.
insert into public.profiles (id, display_name)
select
  u.id,
  left(coalesce(
    nullif(u.raw_user_meta_data->>'display_name', ''),
    nullif(u.raw_user_meta_data->>'full_name', ''),
    nullif(u.raw_user_meta_data->>'name', ''),
    nullif(split_part(u.email, '@', 1), ''),
    'Student'
  ), 24)
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- One-time: make yourself owner (sign in with Google once first so your row exists).
--   update public.profiles set role = 'owner'
--   where id = (select id from auth.users where email = 'you@example.com');
-- The server also treats KLASE_OWNER_USER_ID / KLASE_OWNER_EMAIL as owner and
-- syncs that into profiles.role automatically on the next sign-in.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- /admin brute-force guard. Signed-in accounts that are NOT owner/admin get 3
-- strikes on /api/admin/*, then a 30 minute lockout. Written only by the game
-- server (service role); RLS is on with no policies, so clients can't read or edit it.
-- Run this block after the rest of the file; safe to re-run.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_attempts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  failed_count int not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now()
);

alter table public.admin_attempts enable row level security;

-- Atomic strike: counts a failure, and starts the lock when p_max is reached.
-- An expired lock starts the count over at 1.
create or replace function public.admin_attempt_fail(p_user uuid, p_max int, p_lock_minutes int)
returns table (out_count int, out_locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_attempts as a (user_id, failed_count, last_attempt_at)
  values (p_user, 1, now())
  on conflict (user_id) do update set
    failed_count = case
      when a.locked_until is not null and a.locked_until <= now() then 1
      else a.failed_count + 1 end,
    locked_until = case
      when a.locked_until is not null and a.locked_until > now() then a.locked_until
      else null end,
    last_attempt_at = now();

  update public.admin_attempts a
     set locked_until = now() + make_interval(mins => p_lock_minutes)
   where a.user_id = p_user and a.failed_count >= p_max and a.locked_until is null;

  return query
    select a.failed_count, a.locked_until from public.admin_attempts a where a.user_id = p_user;
end;
$$;

revoke all on function public.admin_attempt_fail(uuid, int, int) from public, anon, authenticated;
grant execute on function public.admin_attempt_fail(uuid, int, int) to service_role;

-- Kick/ban holds. Server (service role) only. Safe to re-run.
create table if not exists public.moderation_holds (
  hold_key text primary key,
  kind text not null check (kind in ('kick', 'ban')),
  until timestamptz,
  reason text not null default '',
  message text not null default '',
  actor_name text not null default '',
  actor_role text not null default 'owner',
  created_at timestamptz not null default now()
);
alter table public.moderation_holds enable row level security;
