import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { supabaseService } from '../config/supabase.js';
import { encrypt } from '../services/encrypt.js';
import { exchangeStravaCode, fetchStravaTrainingSnapshot } from '../services/strava.js';

const router = Router();

// ── GET /api/integrations/strava/connect ─────────────────────────────────────
// Generates a Strava OAuth URL. Stores a short-lived state for CSRF protection.

router.get('/strava/connect', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const state = crypto.randomUUID();
  const stateExp = new Date(Date.now() + 10 * 60 * 1000); // 10-min TTL

  const { error } = await supabaseService
    .from('profiles')
    .update({ strava_oauth_state: state, strava_oauth_state_exp: stateExp.toISOString() })
    .eq('id', userId);

  if (error) {
    console.error('Failed to store Strava OAuth state', { userId, error: error.message });
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Could not initiate Strava connection' } });
    return;
  }

  const frontendOrigin = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '');
  const redirectUri = `${frontendOrigin}/app/strava/callback`;

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'activity:read_all',
    state,
  });

  res.json({ authUrl: `https://www.strava.com/oauth/authorize?${params}` });
});

// ── POST /api/integrations/strava/callback ───────────────────────────────────
// FE calls this after Strava redirects to the callback page with a code.

router.post('/strava/callback', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { code } = req.body as { code?: string };

  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'code is required' } });
    return;
  }

  // Verify the user initiated this OAuth flow within the last 10 minutes
  const { data: profile } = await supabaseService
    .from('profiles')
    .select('strava_oauth_state, strava_oauth_state_exp')
    .eq('id', userId)
    .single();

  if (
    !profile?.strava_oauth_state ||
    !profile.strava_oauth_state_exp ||
    new Date(profile.strava_oauth_state_exp as string) < new Date()
  ) {
    res.status(400).json({ error: { code: 'STRAVA_STATE_EXPIRED', message: 'OAuth session expired — please try connecting again' } });
    return;
  }

  let tokens: Awaited<ReturnType<typeof exchangeStravaCode>>;
  try {
    tokens = await exchangeStravaCode(code);
  } catch (err) {
    console.error('Strava code exchange failed', { userId, error: (err as Error).message });
    res.status(400).json({ error: { code: 'STRAVA_AUTH_FAILED', message: 'Strava authorisation failed — please try again' } });
    return;
  }

  await supabaseService
    .from('profiles')
    .update({
      strava_athlete_id: tokens.athleteId,
      strava_athlete_name: tokens.athleteName,
      strava_profile_pic: tokens.profilePic,
      strava_access_token: encrypt(tokens.accessToken),
      strava_refresh_token: encrypt(tokens.refreshToken),
      strava_token_expires_at: tokens.expiresAt.toISOString(),
      strava_oauth_state: null,
      strava_oauth_state_exp: null,
    })
    .eq('id', userId);

  res.json({ athleteName: tokens.athleteName });
});

// ── GET /api/integrations/strava/status ──────────────────────────────────────

router.get('/strava/status', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data } = await supabaseService
    .from('profiles')
    .select('strava_athlete_id, strava_athlete_name, strava_profile_pic')
    .eq('id', userId)
    .single();

  if (!data?.strava_athlete_id) {
    res.json({ connected: false });
    return;
  }

  res.json({
    connected: true,
    athleteName: data.strava_athlete_name,
    profilePic: data.strava_profile_pic,
  });
});

// ── GET /api/integrations/strava/recent-load ─────────────────────────────────
// Live snapshot of the athlete's last 2 weeks (relative to NOW) for the plan
// page. The Strava tokens never leave the backend — the FE only ever receives
// computed numbers (TSS, hours, daily buckets, …), never the OAuth credential.

router.get('/strava/recent-load', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  const { data, error } = await supabaseService
    .from('profiles')
    .select('strava_access_token, strava_refresh_token, strava_token_expires_at, ftp_watts')
    .eq('id', userId)
    .single();

  if (error || !data) {
    console.error('recent-load profile load failed', { userId, error: error?.message });
    res.status(500).json({ error: { code: 'PROFILE_ERROR', message: 'Failed to load profile' } });
    return;
  }

  const row = data as unknown as Record<string, unknown>;
  if (!row.strava_access_token || !row.strava_refresh_token) {
    res.json({ connected: false, snapshot: null });
    return;
  }

  // Best-effort: a Strava hiccup returns connected:true, snapshot:null so the FE
  // can show a soft "couldn't reach Strava" state rather than a hard error.
  const snapshot = await fetchStravaTrainingSnapshot(
    userId,
    row.strava_access_token as string | null,
    row.strava_refresh_token as string | null,
    row.strava_token_expires_at as string | null,
    row.ftp_watts as number | null,
  );

  res.json({ connected: true, snapshot });
});

// ── DELETE /api/integrations/strava ──────────────────────────────────────────

router.delete('/strava', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  await supabaseService
    .from('profiles')
    .update({
      strava_athlete_id: null,
      strava_athlete_name: null,
      strava_profile_pic: null,
      strava_access_token: null,
      strava_refresh_token: null,
      strava_token_expires_at: null,
      strava_oauth_state: null,
      strava_oauth_state_exp: null,
    })
    .eq('id', userId);

  res.status(204).send();
});

export default router;
