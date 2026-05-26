-- 0002_profile_fields.sql
-- Extends public.profiles with athlete attributes used by the plan generator:
-- body composition, sport-specific performance metrics, fuelling tolerance,
-- and dietary preferences. Also backfills the new `disciplines` array from
-- the legacy `sport` column. The `sport` column itself is kept for now and
-- can be dropped in a follow-up once nothing references it.
--
-- Apply via Supabase SQL editor (run as the postgres role) or `supabase db push`.

-- ============================================================================
-- profiles — add athlete attribute columns
-- ============================================================================
alter table public.profiles
  add column if not exists birth_date date,
  add column if not exists sex text
    check (sex is null or sex in ('female','male','other','prefer_not_to_say')),
  add column if not exists height_cm integer
    check (height_cm is null or (height_cm > 50 and height_cm < 250)),
  add column if not exists disciplines text[] not null default '{}'
    check (disciplines <@ array['cycling','running']::text[]),
  add column if not exists ftp_watts integer
    check (ftp_watts is null or (ftp_watts > 0 and ftp_watts < 700)),
  add column if not exists running_threshold_sec_per_km integer
    check (running_threshold_sec_per_km is null or running_threshold_sec_per_km > 0),
  add column if not exists max_hr integer
    check (max_hr is null or (max_hr > 80 and max_hr < 230)),
  add column if not exists weekly_training_hours numeric(4,1)
    check (weekly_training_hours is null or weekly_training_hours >= 0),
  add column if not exists sweat_rate text
    check (sweat_rate is null or sweat_rate in ('low','medium','high')),
  add column if not exists max_carbs_g_hr integer
    check (max_carbs_g_hr is null or (max_carbs_g_hr >= 0 and max_carbs_g_hr < 200)),
  add column if not exists caffeine_tolerance text
    check (caffeine_tolerance is null or caffeine_tolerance in ('none','low','high')),
  add column if not exists fuel_forms text[] not null default '{}'
    check (fuel_forms <@ array['gels','chews','bars','drink_mix','real_food']::text[]),
  add column if not exists diet text
    check (diet is null or diet in ('omnivore','vegetarian','vegan','pescatarian')),
  add column if not exists restrictions text[] not null default '{}'
    check (restrictions <@ array['gluten','dairy','nuts','soy','eggs','shellfish']::text[]),
  add column if not exists restrictions_other text,
  add column if not exists avoid_notes text;


-- ============================================================================
-- Backfill disciplines from the legacy sport column
-- ============================================================================
update public.profiles
set disciplines = array[sport]
where sport is not null
  and cardinality(disciplines) = 0;


-- ============================================================================
-- Optional cleanup
-- ============================================================================
-- Once the frontend and any backend code no longer reference `sport`, drop it:
-- alter table public.profiles drop column sport;
