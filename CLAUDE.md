# fuelplan-be (backend) — Agent CLAUDE.md

Stack-specific context for the backend agent. You work in this repo (`fuelplan-be/`) only.

> **First:** read `../fuelplan-shared/CLAUDE.md` for cross-cutting orientation and hard rules. They apply here too — this file doesn't repeat them.

## Stack

- Node 20 LTS, ES modules (`"type": "module"` in package.json)
- Express 4
- `@supabase/supabase-js` with service role key
- `stripe` Node SDK
- `@anthropic-ai/sdk` for Claude API
- `gpx-parser-builder` or `gpxparser` for GPX parsing
- Deployed to Render via deploy hook

## Folder structure

```
fuelplan-be/
├── src/
│   ├── lib/
│   │   ├── supabase.js       # Admin client (service role)
│   │   ├── stripe.js         # Stripe SDK instance
│   │   └── anthropic.js      # Claude SDK instance
│   ├── middleware/
│   │   ├── requireAuth.js    # JWT verification
│   │   ├── checkAccess.js    # Plan-tier gating
│   │   └── errorHandler.js   # Last-resort error -> JSON
│   ├── routes/
│   │   ├── plans.js          # POST /api/plans (generate), GET /api/plans/:id
│   │   ├── profile.js        # GET/PATCH /api/profile
│   │   ├── checkout.js       # POST /api/checkout/session
│   │   └── stripe-webhook.js # POST /webhook/stripe
│   ├── services/
│   │   ├── gpxParser.js
│   │   └── planGenerator.js  # Claude API call + JSON parse
│   ├── app.js                # Express app setup
│   └── server.js             # Boots app, reads PORT
├── migrations/               # SQL files, numbered
├── .claude/
│   └── skills/               # Backend-specific patterns
├── CLAUDE.md                 # This file
├── WIP.md                    # Session handoff
├── .env                      # local only — gitignored
└── package.json
```

## Hard rules — backend-specific

(In addition to the cross-cutting rules in `../fuelplan-shared/CLAUDE.md`.)

1. **Service role key is the keys-to-the-kingdom.** It bypasses RLS. Use the admin client only where necessary; for "read this user's profile to display it back", prefer using the user's JWT.
2. **Every route handler that touches user data starts with `requireAuth`.** Then `checkPlanAccess` if it's a paid action (plan generation, etc.).
3. **Stripe webhook is mounted with `express.raw()`, not `express.json()`.** Signature verification requires the unmodified raw body. Mount the webhook route BEFORE `app.use(express.json())` in `app.js`.
4. **Webhook handlers are idempotent.** Every handler checks if `event.id` has been processed before doing anything. Use a `processed_stripe_events` table or upserts with a unique constraint.
5. **Never return raw errors to the client.** Catch, log, return a sanitised JSON error. Stack traces leak structure.
6. **GPX files have a hard size limit.** 5 MB is generous. Reject larger before parsing.
7. **Claude API responses are not trusted JSON.** Parse defensively. Validate the shape against an expected schema (Zod or hand-rolled) before persisting.

## Patterns

### Express app boot order
```js
// src/app.js
import express from 'express'
import cors from 'cors'
import stripeWebhook from './routes/stripe-webhook.js'
import { errorHandler } from './middleware/errorHandler.js'

const app = express()

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: false }))

// Webhook FIRST with raw body parser
app.use('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhook)

// Then JSON for everything else
app.use(express.json({ limit: '1mb' }))

// Routes
app.use('/api/plans', plansRouter)
app.use('/api/profile', profileRouter)
app.use('/api/checkout', checkoutRouter)

app.use(errorHandler)

export default app
```

### Admin Supabase client
```js
// src/lib/supabase.js
import { createClient } from '@supabase/supabase-js'

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)
```

### Error response shape
Always:
```json
{ "error": { "code": "PLAN_LIMIT_REACHED", "message": "Free tier allows 1 plan per month." } }
```
Status codes: 400 (bad input), 401 (no/bad token), 403 (access denied), 404 (not found), 409 (conflict/idempotency), 429 (rate limit), 500 (bug).

## Common mistakes to avoid

- **Mounting `express.json()` before the Stripe webhook.** The signature won't verify. The webhook will silently fail in production and users will get charged without subscription rows.
- **Trusting `req.body` from the webhook.** Verify the signature first, *then* trust `event.data.object`.
- **Forgetting idempotency on `checkout.session.completed`.** Stripe will retry on timeouts. If you naively `credits + 1` you'll over-credit.
- **Returning user objects with internal fields.** Strip Supabase internal fields (`raw_user_meta_data`, etc.) before returning to frontend.
- **Calling Anthropic API without a timeout.** Long routes (90s+) tie up Render workers and trigger gateway timeouts. Set a 60s timeout on the SDK call and return a useful error if it busts.
- **Logging the full JWT in errors.** Log `user.id`, not the token.

## Skills available

- `.claude/skills/new-express-route/` — file location, middleware order, validation, error shape
- `.claude/skills/stripe-webhook-handler/` — signature verification, idempotency, Supabase upsert
- `.claude/skills/supabase-migration/` — SQL conventions, RLS policy template

Read the relevant `SKILL.md` before implementing.

## Build & deploy

- `npm run dev` — local with `node --watch src/server.js`
- No build step (plain Node)
- GitHub Actions hits the Render deploy hook on push to `main`
- Required env vars listed in `../fuelplan-shared/architecture.md` (`SUPABASE_*`, `STRIPE_*`, `ANTHROPIC_API_KEY`, `PORT`, `FRONTEND_URL`)
