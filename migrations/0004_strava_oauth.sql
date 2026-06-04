-- 0004_strava_oauth.sql
-- Adds Strava OAuth columns to profiles.
-- Tokens are stored encrypted at rest (AES-256-GCM by the service layer) —
-- the plaintext ENCRYPTION_KEY exists only in the backend .env, never the DB.
-- The strava_oauth_state columns are used for CSRF protection during the OAuth
-- flow and are cleared immediately after the callback completes.
--
-- Apply via Supabase SQL editor (run as the postgres role) or `supabase db push`.

alter table public.profiles
  add column if not exists strava_athlete_id       bigint,
  add column if not exists strava_athlete_name     text,
  add column if not exists strava_profile_pic      text,
  add column if not exists strava_access_token     text,
  add column if not exists strava_refresh_token    text,
  add column if not exists strava_token_expires_at timestamptz,
  add column if not exists strava_oauth_state      text,
  add column if not exists strava_oauth_state_exp  timestamptz;

-- These columns are intentionally not exposed in the anon-key RLS select
-- policy used by the frontend (useProfile selects specific columns only).
-- The backend reads/writes them exclusively via the service role client.
