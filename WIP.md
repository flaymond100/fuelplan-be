# fuelplan-be (backend) — Work In Progress

> Per-repo session state. Read first on session start. Update last on session end.
> Cross-repo coordination goes in `../fuelplan-shared/WIP.md` instead.

## Done this session

- Added initial schema migration [migrations/0001_init.sql](migrations/0001_init.sql): `profiles`, `plans`, `subscriptions`, `plan_credits`, `processed_stripe_events` + RLS, auto-profile trigger, `gpx-files` storage bucket.

## Next up

- Apply `0001_init.sql` to the dedicated Supabase project via SQL editor.
- Verify the `on_auth_user_created` trigger fires by signing up a test user.
- Wire `src/lib/supabase.js` (admin client) and `requireAuth` middleware.

## Blocked / waiting on

- Need the dedicated Supabase project credentials in `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`).

## Mid-edit files

> Ideally none — finish a slice, commit, then stop.

- (none)

## Notes for next session

- (e.g. The Pálava test GPX has 12k points — added downsampling to `gpxParser.js`. Watch token usage on longer routes.)
