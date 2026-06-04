import { encrypt, decrypt } from './encrypt.js';
import { supabaseService } from '../config/supabase.js';

export interface RecentActivity {
  type: string;
  daysBeforeRace: number;          // positive = before race, 0 = race day
  durationMin: number;
  distanceKm: number;
  elevationM: number | null;
  avgWatts: number | null;
  normalizedWatts: number | null;  // weighted_average_watts — NP proxy
  kilojoules: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgSpeedKmh: number | null;      // useful for runners (convert to pace)
  sufferScore: number | null;
  tssEstimate: number | null;      // computed: (duration * NP * IF) / (FTP * 3600) * 100
  intensityFactor: number | null;  // NP / FTP
}

export interface StravaTrainingBlock {
  activities: RecentActivity[];
  totalHours: number;
  totalKj: number | null;
  totalTss: number | null;
  daysSinceLastWorkout: number;
  activeDays: number;
}

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

// ── Token exchange (OAuth callback) ─────────────────────────────────────────

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: {
    id: number;
    firstname?: string;
    lastname?: string;
    profile?: string;
  };
}

export async function exchangeStravaCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  athleteId: number;
  athleteName: string;
  profilePic: string;
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: parseInt(process.env.STRAVA_CLIENT_ID ?? '', 10),
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strava token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json() as StravaTokenResponse;
  const athlete = data.athlete;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(data.expires_at * 1000),
    athleteId: athlete?.id ?? 0,
    athleteName: [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' '),
    profilePic: athlete?.profile ?? '',
  };
}

// ── Token refresh (internal — called before any Strava API request) ──────────

async function refreshToken(userId: string, encRefreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: parseInt(process.env.STRAVA_CLIENT_ID ?? '', 10),
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: decrypt(encRefreshToken),
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      console.error('Strava refresh failed', { userId, status: res.status });
      return null;
    }

    const data = await res.json() as StravaTokenResponse;

    await supabaseService
      .from('profiles')
      .update({
        strava_access_token: encrypt(data.access_token),
        strava_refresh_token: encrypt(data.refresh_token),
        strava_token_expires_at: new Date(data.expires_at * 1000).toISOString(),
      })
      .eq('id', userId);

    return data.access_token;
  } catch (err) {
    console.error('Strava refresh error', { userId, error: (err as Error).message });
    return null;
  }
}

// ── Activity fetch for plan generation ───────────────────────────────────────
// Fetches the last 14 activities from Strava. Never throws — plan generation
// must complete even if Strava is unavailable.

export async function fetchStravaRecentLoad(
  userId: string,
  encAccessToken: string | null,
  encRefreshToken: string | null,
  tokenExpiresAt: string | null,
  raceDate: string,
  ftpWatts: number | null,
): Promise<StravaTrainingBlock | null> {
  if (!encAccessToken || !encRefreshToken) return null;

  try {
    const expiresAt = tokenExpiresAt ? new Date(tokenExpiresAt) : null;
    let accessToken: string;

    if (!expiresAt || Date.now() > expiresAt.getTime() - 5 * 60 * 1000) {
      const fresh = await refreshToken(userId, encRefreshToken);
      if (!fresh) return null;
      accessToken = fresh;
    } else {
      accessToken = decrypt(encAccessToken);
    }

    // Fetch last 14 activities (no after filter — we want current training state)
    const url = `${ACTIVITIES_URL}?per_page=14`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!res.ok) {
      console.error('Strava activities fetch failed', { userId, status: res.status });
      return null;
    }

    const raw = await res.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const raceDateMs = new Date(raceDate).getTime();
    const nowMs = Date.now();

    const activities: RecentActivity[] = raw.map((a) => {
      const movingSec = Number(a.moving_time ?? 0);
      const durationMin = Math.round(movingSec / 60);
      const np = a.weighted_average_watts != null ? Math.round(Number(a.weighted_average_watts)) : null;
      const avgW = a.average_watts != null ? Math.round(Number(a.average_watts)) : null;
      const kj = a.kilojoules != null ? Math.round(Number(a.kilojoules)) : null;
      const startMs = a.start_date ? new Date(String(a.start_date)).getTime() : nowMs;
      const daysBeforeRace = Math.round((raceDateMs - startMs) / 86400000);

      // TSS estimate: (t_s * NP * IF) / (FTP * 3600) * 100
      let tssEstimate: number | null = null;
      let intensityFactor: number | null = null;
      if (np && ftpWatts && ftpWatts > 0) {
        intensityFactor = parseFloat((np / ftpWatts).toFixed(2));
        tssEstimate = Math.round((movingSec * np * intensityFactor) / (ftpWatts * 3600) * 100);
      }

      return {
        type: String(a.sport_type ?? a.type ?? 'Unknown'),
        daysBeforeRace,
        durationMin,
        distanceKm: parseFloat((Number(a.distance ?? 0) / 1000).toFixed(1)),
        elevationM: a.total_elevation_gain != null ? Math.round(Number(a.total_elevation_gain)) : null,
        avgWatts: avgW,
        normalizedWatts: np,
        kilojoules: kj,
        avgHr: a.average_heartrate != null ? Math.round(Number(a.average_heartrate)) : null,
        maxHr: a.max_heartrate != null ? Math.round(Number(a.max_heartrate)) : null,
        avgSpeedKmh: a.average_speed != null
          ? parseFloat((Number(a.average_speed) * 3.6).toFixed(1))
          : null,
        sufferScore: a.suffer_score != null ? Math.round(Number(a.suffer_score)) : null,
        tssEstimate,
        intensityFactor,
      };
    });

    const totalHours = parseFloat((activities.reduce((s, a) => s + a.durationMin, 0) / 60).toFixed(1));
    const totalKj = activities.some((a) => a.kilojoules != null)
      ? activities.reduce((s, a) => s + (a.kilojoules ?? 0), 0)
      : null;
    const totalTss = activities.some((a) => a.tssEstimate != null)
      ? activities.reduce((s, a) => s + (a.tssEstimate ?? 0), 0)
      : null;

    const mostRecentMs = raw[0]?.start_date
      ? new Date(String(raw[0].start_date)).getTime()
      : nowMs;
    const daysSinceLastWorkout = Math.floor((nowMs - mostRecentMs) / 86400000);
    const activeDays = new Set(
      raw.map((a) => a.start_date ? new Date(String(a.start_date)).toDateString() : '')
    ).size;

    return { activities, totalHours, totalKj, totalTss, daysSinceLastWorkout, activeDays };
  } catch (err) {
    console.error('Strava activity fetch error', { userId, error: (err as Error).message });
    return null;
  }
}
