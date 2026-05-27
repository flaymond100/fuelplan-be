# fuelplan-be (backend) — Work In Progress

> Per-repo session state. Read first on session start. Update last on session end.
> Cross-repo coordination goes in `../fuelplan-shared/WIP.md` instead.

## Done this session (2026-05-27 follow-up)

- Added initial schema migration [migrations/0001_init.sql](migrations/0001_init.sql): `profiles`, `plans`, `subscriptions`, `plan_credits`, `processed_stripe_events` + RLS, auto-profile trigger, `gpx-files` storage bucket.
- Added athlete profile fields migration [migrations/0002_profile_fields.sql](migrations/0002_profile_fields.sql).
- **Plan generation pipeline (this session):**
  - [migrations/0003_plan_request_params.sql](migrations/0003_plan_request_params.sql) — adds `request_params jsonb` column to `plans` and the `insert_plan_and_decrement_credit` RPC function (atomic plan insert + credit decrement in one transaction).
  - [src/services/gpxParser.ts](src/services/gpxParser.ts) — server-side GPX parse: haversine distance + smoothed elevation gain, 5 MB hard limit, defensive XML parsing via `fast-xml-parser`.
  - [src/services/planGenerator.ts](src/services/planGenerator.ts) — Claude Sonnet prompt builder, 60s timeout, response validator against the plan_json schema (decision 0003).
  - [src/routes/plans.ts](src/routes/plans.ts) — `POST /api/plans/generate` (multipart; requireAuth + checkPlanAccess) and `GET /api/plans/:id`.
  - [src/app.ts](src/app.ts) — wired `plansRouter` at `/api/plans`.
  - [../fuelplan-shared/decisions/0003-plan-json-schema.md](../fuelplan-shared/decisions/0003-plan-json-schema.md) — locked plan_json schema.

- **GPX signed URL endpoint**: `GET /api/plans/:id/gpx` — verifies ownership, returns 5-min signed URL from `gpx-files` bucket. FE wires `useRouteTrack` against it.
- **Schema doc reconciliation**: updated `decisions/0003` to match deployed code — `fatG`/`proteinG` (not `fat`/`protein`) and 6 phase IDs. No code or FE changes required.

## Resolved handoff (frontend → backend, decision 0004) — DONE 2026-05-27

> **Full spec:** [HANDOVER-rich-plan-fields.md](HANDOVER-rich-plan-fields.md) · contract [../fuelplan-shared/decisions/0004-plan-json-rich-fields.md](../fuelplan-shared/decisions/0004-plan-json-rich-fields.md).

Implemented the four optional, additive `plan_json` rendering fields in [src/services/planGenerator.ts](src/services/planGenerator.ts). No migration, `schemaVersion` still `1`. Typecheck passes.

- **`item.kind`** — optional enum `meal | snack | fuel | supplement | hydration | action`. Added to the item template in `buildPrompt`; validated against `VALID_ITEM_KINDS` in `validateItem`, dropped when absent/invalid.
- **`item.detail`** — optional string; kept when a non-empty string, omitted otherwise.
- **`phase.macros`** — optional `{ label, tone? }[]`; new `validateMacros` helper drops malformed chips (and unknown tones) rather than failing the plan.
- **`plan.alerts`** — optional `{ severity, title, body }[]`; new `validateAlerts` helper. `warnings[]` still emitted and validated exactly as before.
- Prompt now instructs: pre-race supplements → `supplement` (+`detail`), in-race gels/fuel → `fuel`, logistics → `action` (zero nutrients), per-pre-race-day `macros` with g/kg targets + tone, and top-level `alerts` mirroring `warnings`.
- Lenient-on-optional / strict-on-structure preserved: malformed optional fields are dropped, not fatal; bad core structure still throws → HTTP 500 `PLAN_GENERATION_FAILED`.

## Next up

- Apply migrations `0001`, `0002`, `0003` to the Supabase project via SQL editor (in order).
- Verify the `on_auth_user_created` trigger fires by signing up a test user.
- Smoke-test the generate endpoint with a real GPX file and a seeded test user.
- Stripe webhook + checkout routes (separate session).

## Blocked / waiting on

- Need Supabase project credentials in `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`).
- Need `ANTHROPIC_API_KEY` in `.env` for local testing of generation.

## Mid-edit files

- (none)

## Notes for next session

- Large GPX files (>10k points) are parsed fine but watch Anthropic token usage if the route summary ever gets embedded verbatim — currently we only pass totals (distance, elevation, point count).
- The `insert_plan_and_decrement_credit` RPC uses `FOR UPDATE` on `subscriptions` to prevent race conditions on free-tier concurrent requests.
- Claude response validation is strict on structure but lenient on numeric precision (all fields rounded to nearest integer). If Claude starts producing unrealistic totals, add range checks to `validatePlanJson`.
