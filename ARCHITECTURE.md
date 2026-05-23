# FuelPlan — Architecture

An AI-powered race nutrition planner for cyclists and runners. Two repos + one dedicated Supabase project + Stripe + Anthropic Claude.

---

## Repos

| Path | Purpose |
|---|---|
| `/Users/prln255/fuelplan` | **Frontend** — React + Vite + TypeScript, GitHub Pages |
| `/Users/prln255/fuelplan-be` | **Backend** — Express + TypeScript, Render |

Both connect to the same dedicated Supabase project (separate from revolution-crit).

---

## Stack

- **Frontend**: React 19, Vite, TypeScript, Tailwind v4, React Router v7, TanStack Query v5, `@supabase/supabase-js`, `react-hot-toast`
- **Backend**: Express 5, TypeScript, `@supabase/supabase-js`, `stripe`, `@anthropic-ai/sdk`, `multer` (GPX uploads), `cors`, `express-validator`
- **Database**: Supabase (Postgres + RLS + Storage for GPX files)
- **Payments**: Stripe Checkout Sessions + webhooks
- **AI**: Claude (Anthropic API) — generates nutrition plans server-side only
- **Hosting**: Frontend = GitHub Pages. Backend = Render (free tier, keep-alive via UptimeRobot or upgrade to Starter).

---

## Database Schema

Five tables. RLS enabled on all.

```
profiles              One row per auth user (auto-created via trigger)
  ├── id (uuid, FK → auth.users)
  ├── email, full_name, weight_kg
  ├── sport ('cycling' | 'running')
  └── supplements text[]

plans                 Every generated nutrition plan
  ├── id (uuid)
  ├── user_id → profiles.id
  ├── race_name, race_date, distance_km, elevation_m, start_time
  ├── gpx_file_path (path in Supabase Storage bucket 'gpx-files')
  └── plan_json (jsonb — full AI output)

subscriptions         Synced from Stripe webhooks — source of truth for access
  ├── id (uuid)
  ├── user_id → profiles.id
  ├── stripe_customer_id, stripe_sub_id
  ├── plan ('free' | 'pro' | 'pay_per_plan')
  └── status ('active' | 'canceled' | 'past_due' | 'trialing')

plan_credits          Tracks pay-per-plan purchases and free-tier usage
  ├── user_id → profiles.id
  ├── credits (remaining paid generations)
  ├── used_this_month (resets monthly for free tier)
  └── reset_at (next monthly reset timestamp)
```

### Access tiers

| Tier | `plan` value | Gate |
|---|---|---|
| Free | `free` | `used_this_month < 1` (resets monthly) |
| Pro | `pro` | `status = 'active'` |
| Pay-per-plan | `pay_per_plan` | `credits > 0` |

Access checked in `src/middleware/checkAccess.ts` on the backend — never trust client.

### GPX Storage

```
Bucket: gpx-files (private)
Path:   {user_id}/{plan_id}.gpx
Access: service role only — no public URLs
```

---

## Backend (`fuelplan-be`)

Entry: `index.ts` → `src/app.ts`.

### Key files

```
src/
├── app.ts                        Express app, CORS, routes, error handler
├── config/
│   ├── supabase.ts               Two clients: supabase (anon/RLS) + supabaseService (service role)
│   ├── stripe.ts                 Stripe client singleton
│   └── anthropic.ts              Anthropic client singleton
├── middleware/
│   ├── authenticate.ts           Verifies Supabase JWT, attaches req.user
│   └── checkAccess.ts            Checks subscription/credits before plan generation
├── routes/                       (to be added per feature)
├── controllers/                  (to be added per feature)
├── services/                     (to be added per feature)
└── types/
    └── express.d.ts              Augments Express Request with req.user
```

### CORS

Same pattern as revolution-crit: `isDev` auto-allows any `localhost:*`. In production, validates against `ALLOWED_ORIGINS` env var. Stripe webhook route registered before `express.json()` so raw body is preserved for signature verification.

### Plan generation flow (planned)

1. FE POSTs `/api/plans/generate` with `{ raceId, gpxFile? }` + Bearer token
2. BE `authenticate` → `checkAccess` → calls Claude with race data + GPX summary
3. Streams or returns full plan JSON; saves to `plans` table via `supabaseService`
4. Decrements `plan_credits.used_this_month` (free) or `credits` (pay-per-plan)

### Stripe flow

Same pattern as revolution-crit:
- `/api/payments/create-checkout` — creates Stripe Checkout Session (subscription or one-off credit pack)
- `/api/payments/webhook` (raw body) — handles `checkout.session.completed`, `customer.subscription.updated`, etc.
- Amount never trusted from client; product/price resolved server-side.

---

## Frontend (`fuelplan`)

Entry: `src/main.tsx` → `src/App.tsx`.

### Key files

```
src/
├── App.tsx                       Routes + QueryClient + Toaster
├── lib/
│   └── supabase.ts               FE Supabase client (anon key)
├── components/
│   └── RequireAuth.tsx           Redirects to /login if no session
└── types.ts                      DB row types (snake_case) + domain types (camelCase)
```

### Routes (planned)

| Path | Notes |
|---|---|
| `/` | Dashboard / plan list |
| `/login` | Auth page (email+password + Google OAuth) |
| `/onboarding` | Profile setup (sport, weight, supplements) |
| `/plans/new` | Race input form + GPX upload → triggers plan generation |
| `/plans/:id` | Rendered nutrition plan |
| `/account` | Profile + subscription management |
| `/pricing` | Tier comparison + Stripe Checkout CTAs |

All routes except `/login` and `/pricing` wrapped in `<RequireAuth>`.

---

## Auth

Supabase Auth — JWT sessions, Google OAuth, email+password. Frontend uses `supabase.auth.getSession()` and `onAuthStateChange`. Backend verifies JWT via `supabase.auth.getUser(token)` in `authenticate` middleware. A Supabase trigger auto-creates a `profiles` row on sign-up.

---

## Environment Variables

### Frontend (`.env`)
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_STRIPE_PUBLIC_KEY=
VITE_API_URL=http://localhost:3001   # or https://api.fuelplan.app
```

### Backend (`.env`)
```
PORT=3001
NODE_ENV=development
ALLOWED_ORIGINS=https://fuelplan.app

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

ANTHROPIC_API_KEY=sk-ant-...
```

---

## Deployment

### Frontend → GitHub Pages
Same GitHub Actions pipeline as revolution-crit. Build on push to `main`, deploy `dist/` to `gh-pages` branch.

### Backend → Render
- Build: `npm install && npm run build`
- Start: `npm start` (`node dist/index.js`)
- Auto-deploy on push to `main`.
- Free tier spins down after 15 min idle — use UptimeRobot on `/health`.

---

## Conventions (same as revolution-crit)

- **Snake_case for DB row interfaces**, camelCase for domain types. Mappers at the lib layer.
- **Server-authoritative access control.** Client never decides if a plan can be generated.
- **`supabaseService` (service role) only on BE** — never expose to frontend.
- **Stripe webhook raw body** registered before `express.json()`.
- **No bespoke error toasts** — errors shown inline; success uses `react-hot-toast`.
