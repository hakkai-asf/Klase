-- Run in the Supabase SQL editor. Account mode needs this; guest join works without it.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Student',
  role text not null default 'user' check (role in ('owner', 'admin', 'user')),
  hat text not null default '',
  top text not null default '',
  accessory text not null default '',
  banned boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read profiles" on public.profiles;
create policy "read profiles"
  on public.profiles for select
  using (true);

drop policy if exists "update own look" on public.profiles;
create policy "update own look"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = (select p.role from public.profiles p where p.id = auth.uid())
    and banned = (select p.banned from public.profiles p where p.id = auth.uid())
  );

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
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), 'Student')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
