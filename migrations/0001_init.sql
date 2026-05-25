-- 0001_init.sql
-- Initial schema for fuelplan: profiles, plans, subscriptions, plan_credits,
-- processed_stripe_events, plus auto-profile trigger, RLS, and gpx-files bucket.
--
-- Apply via Supabase SQL editor (run as the postgres role) or `supabase db push`.

-- ============================================================================
-- profiles — one row per auth user, auto-created via trigger
-- ============================================================================
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  weight_kg   numeric(5,2) check (weight_kg is null or (weight_kg > 0 and weight_kg < 500)),
  sport       text check (sport in ('cycling', 'running')),
  supplements text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy profiles_select_own
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No insert/delete policies: rows are created by the trigger below and deleted
-- via auth.users cascade. Service role bypasses RLS for any admin operation.


-- ============================================================================
-- plans — every generated nutrition plan
-- ============================================================================
create table public.plans (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  race_name     text not null,
  race_date     date not null,
  distance_km   numeric(7,2) check (distance_km is null or distance_km > 0),
  elevation_m   integer check (elevation_m is null or elevation_m >= 0),
  start_time    time,
  gpx_file_path text,
  plan_json     jsonb,
  created_at    timestamptz not null default now()
);

create index plans_user_race_date_idx on public.plans (user_id, race_date desc);

alter table public.plans enable row level security;

create policy plans_select_own
  on public.plans for select to authenticated
  using ((select auth.uid()) = user_id);

-- No insert/update/delete from frontend. The backend writes via service role
-- after running checkAccess + generating the plan with Claude.


-- ============================================================================
-- subscriptions — synced from Stripe webhooks, source of truth for access
-- ============================================================================
create table public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references public.profiles(id) on delete cascade,
  stripe_customer_id  text unique,
  stripe_sub_id       text unique,
  plan                text not null default 'free'
                        check (plan in ('free', 'pro', 'pay_per_plan')),
  status              text not null default 'active'
                        check (status in ('active', 'canceled', 'past_due', 'trialing')),
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index subscriptions_stripe_customer_id_idx on public.subscriptions (stripe_customer_id);

alter table public.subscriptions enable row level security;

create policy subscriptions_select_own
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

-- No write policies: only the Stripe webhook (service role) mutates this table.


-- ============================================================================
-- plan_credits — pay-per-plan credits + free-tier monthly usage
-- ============================================================================
create table public.plan_credits (
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  credits         integer not null default 0 check (credits >= 0),
  used_this_month integer not null default 0 check (used_this_month >= 0),
  reset_at        timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  updated_at      timestamptz not null default now()
);

alter table public.plan_credits enable row level security;

create policy plan_credits_select_own
  on public.plan_credits for select to authenticated
  using ((select auth.uid()) = user_id);

-- No write policies: only the backend (service role) decrements credits and
-- resets monthly counters.


-- ============================================================================
-- processed_stripe_events — webhook idempotency
-- ============================================================================
create table public.processed_stripe_events (
  event_id     text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

alter table public.processed_stripe_events enable row level security;
-- No policies: service role only.


-- ============================================================================
-- updated_at trigger helper
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

create trigger plan_credits_set_updated_at
  before update on public.plan_credits
  for each row execute function public.set_updated_at();


-- ============================================================================
-- handle_new_user — auto-create profile + free subscription + credit row
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    )
  );

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active');

  insert into public.plan_credits (user_id)
  values (new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- Storage: gpx-files bucket (private, service-role-only access)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('gpx-files', 'gpx-files', false)
on conflict (id) do nothing;

-- No storage.objects policies — anon/authenticated cannot read or write.
-- Backend uses the service role client to upload to {user_id}/{plan_id}.gpx
-- and to issue short-lived signed URLs when needed.
