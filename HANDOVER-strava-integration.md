# Handover → Backend: Strava OAuth integration

**From:** frontend (`fuelplan`) · **Date:** 2026-06-04
**Hard rules:** tokens are secrets — never near `VITE_*`, every route uses `requireAuth`.

---

## What the FE expects

Four backend endpoints and a DB column. The frontend is fully built and waiting.

### 1. `GET /api/integrations/strava/connect`

Returns the Strava OAuth authorization URL. FE navigates the user there.

```json
{ "authUrl": "https://www.strava.com/oauth/authorize?client_id=...&redirect_uri=...&scope=activity:read_all&state=...&response_type=code" }
```

- `redirect_uri` must be the FE callback page: `<FRONTEND_ORIGIN>/app/strava/callback`  
  (set `FRONTEND_ORIGIN` in `.env`, e.g. `https://fuelplan.app` or `http://localhost:5173` for dev)
- Use a random `state` (crypto uuid) to prevent CSRF. Store it in a short-lived entry — either a signed JWT you verify in the callback, or a `strava_oauth_state` column on `profiles` with TTL.

---

### 2. `POST /api/integrations/strava/callback`

Called by the FE callback page after Strava redirects.

**Request body:**
```json
{ "code": "<authorization_code_from_strava>" }
```

**Steps:**
1. Exchange `code` for tokens: `POST https://www.strava.com/oauth/token` with `client_id`, `client_secret`, `code`, `grant_type: authorization_code`.
2. Strava returns `access_token`, `refresh_token`, `expires_at` (unix timestamp), and an `athlete` object.
3. Store on the `profiles` row (see DB section below):
   - `strava_athlete_id`, `strava_athlete_name`, `strava_profile_pic`
   - `strava_access_token` (encrypted), `strava_refresh_token` (encrypted), `strava_token_expires_at`
4. Return `{ athleteName: string }`.

**Error:** if exchange fails, return 400.

---

### 3. `GET /api/integrations/strava/status`

Returns whether the current user has a connected Strava account.

```json
// connected
{ "connected": true, "athleteName": "Kostiantyn G.", "profilePic": "https://..." }

// not connected
{ "connected": false }
```

---

### 4. `DELETE /api/integrations/strava`

Disconnects — clears `strava_*` columns from `profiles`. Returns 204.

---

## DB changes — new migration `0004_strava_oauth.sql`

Add to the `profiles` table:

```sql
alter table profiles
  add column strava_athlete_id       bigint,
  add column strava_athlete_name     text,
  add column strava_profile_pic      text,
  add column strava_access_token     text,   -- store encrypted at rest
  add column strava_refresh_token    text,   -- store encrypted at rest
  add column strava_token_expires_at timestamptz;
```

RLS: these columns are **not** readable via the anon key. The backend service role reads/writes them via `requireAuth` routes. Do **not** expose them in the Supabase client-side query the FE uses for `useProfile`.

For encryption at rest, use `pgcrypto` symmetric encryption or an AES helper in the service layer.

---

## Token refresh helper

Strava access tokens expire in ~6h. Before any Strava API call, check `strava_token_expires_at`:

```ts
if (Date.now() / 1000 > strava_token_expires_at - 300) {
  // refresh: POST https://www.strava.com/oauth/token
  //   { client_id, client_secret, refresh_token, grant_type: 'refresh_token' }
  // update strava_access_token, strava_refresh_token, strava_token_expires_at
}
```

---

## Using activities in plan generation

In `src/services/planGenerator.ts`, after resolving the athlete profile:

```ts
const stravaContext = await fetchStravaRecentLoad(profile, raceDate);
// inject into buildPrompt as a "Recent training (72h before race)" section
```

```ts
async function fetchStravaRecentLoad(profile: AthleteProfile, raceDate: string) {
  if (!profile.strava_access_token) return null;
  await maybeRefreshStravaToken(profile);

  const before = Math.floor(new Date(raceDate).getTime() / 1000);
  const after  = before - 3 * 86400;

  const res = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=10`,
    { headers: { Authorization: `Bearer ${profile.strava_access_token}` } }
  );
  const activities = await res.json();
  return activities.map((a) => ({
    type: a.type,
    durationMin: Math.round(a.moving_time / 60),
    distanceKm: +(a.distance / 1000).toFixed(1),
    avgWatts: a.average_watts ?? null,
    sufferScore: a.suffer_score ?? null,
  }));
}
```

Add to the prompt (in `buildPrompt`) as a new section:

```
## Recent training (72h before race)
${stravaContext.map(a => `- ${a.type}: ${a.durationMin} min, ${a.distanceKm} km${a.avgWatts ? `, ${a.avgWatts}W avg` : ''}`).join('\n')}
```

If Strava call fails or returns empty, omit the section entirely (never fail the whole plan over this).

---

## Env vars to add to `.env`

```
STRAVA_CLIENT_ID=<from strava.com/settings/api>
STRAVA_CLIENT_SECRET=<from strava.com/settings/api>
FRONTEND_ORIGIN=http://localhost:5173    # or https://fuelplan.app in prod
```

---

## Register the Strava app

Go to [strava.com/settings/api](https://www.strava.com/settings/api):
- **Application name**: Fuelplan
- **Category**: Sports nutrition / training
- **Authorization callback domain**: `localhost` (dev) / `fuelplan.app` (prod)

The `redirect_uri` you pass in the auth URL must match this domain exactly.

---

## Acceptance criteria

- `GET /api/integrations/strava/status` returns `{ connected: false }` for a fresh user.
- Full OAuth flow connects and `/status` returns `{ connected: true, athleteName: "..." }`.
- `DELETE /api/integrations/strava` clears the connection.
- A plan generated for a user with Strava connected and a race date within the next 16 days includes recent activity context in the prompt.
- If Strava is connected but the token refresh fails (e.g. user revoked access on Strava), the plan generation still completes — just without the activity context.
- Tokens are never logged or returned to the FE after the initial callback response.
