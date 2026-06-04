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

// ── Training snapshot (last 2 weeks relative to NOW) ─────────────────────────
// Powers the "your last 2 weeks" visualisation on the plan page. Unlike the
// race-relative block above, this is keyed to the current date and is fetched
// live each time a plan is opened.

export interface SnapshotActivity {
  type: string;
  name: string;
  date: string;                    // YYYY-MM-DD (athlete-local)
  daysAgo: number;
  durationMin: number;
  distanceKm: number;
  elevationM: number | null;
  avgWatts: number | null;
  normalizedWatts: number | null;
  avgHr: number | null;
  avgSpeedKmh: number | null;
  tss: number | null;
  intensityFactor: number | null;
  kilojoules: number | null;
}

export interface DailyLoad {
  date: string;                    // YYYY-MM-DD
  label: string;                   // weekday abbreviation, e.g. "Mon"
  tss: number;
  hours: number;
  sessions: number;
}

export interface SportBreakdown {
  type: string;
  sessions: number;
  hours: number;
  tss: number | null;
}

export interface StravaTrainingSnapshot {
  generatedAt: string;             // ISO timestamp the snapshot was computed
  rangeStart: string;              // YYYY-MM-DD (oldest day shown)
  rangeEnd: string;                // YYYY-MM-DD (most recent day shown)
  ftpUsed: number | null;          // FTP used for the TSS maths, if any
  hasPower: boolean;               // any activity carried power → TSS is real
  totals: {
    sessions: number;
    hours: number;
    tss: number | null;
    kj: number | null;
    distanceKm: number;
    elevationM: number;
    activeDays: number;
  };
  thisWeek: { tss: number | null; hours: number; sessions: number };  // days 0–6
  prevWeek: { tss: number | null; hours: number; sessions: number };  // days 7–13
  rampPct: number | null;          // (thisWeek − prevWeek) / prevWeek × 100
  daysSinceLastWorkout: number | null;
  longestSession: { type: string; durationMin: number; distanceKm: number } | null;
  daily: DailyLoad[];              // 14 buckets, oldest → newest
  sports: SportBreakdown[];        // sorted by hours desc
  activities: SnapshotActivity[];  // most recent first
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

// ── Token helper ─────────────────────────────────────────────────────────────
// Returns a usable access token, refreshing if it's within 5 min of expiry.
// Returns null if anything is missing or the refresh fails.

async function ensureAccessToken(
  userId: string,
  encAccessToken: string,
  encRefreshToken: string,
  tokenExpiresAt: string | null,
): Promise<string | null> {
  const expiresAt = tokenExpiresAt ? new Date(tokenExpiresAt) : null;
  if (!expiresAt || Date.now() > expiresAt.getTime() - 5 * 60 * 1000) {
    return refreshToken(userId, encRefreshToken);
  }
  return decrypt(encAccessToken);
}

// ── Per-activity metric extraction ───────────────────────────────────────────
// Shared by the race-relative block and the now-relative snapshot. Pure: takes
// one raw Strava activity + FTP, returns canonical numbers. No day-offset here —
// callers compute that against their own reference date.

interface ActivityCore {
  type: string;
  name: string;
  movingSec: number;
  durationMin: number;
  distanceKm: number;
  elevationM: number | null;
  avgWatts: number | null;
  normalizedWatts: number | null;
  kilojoules: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgSpeedKmh: number | null;
  sufferScore: number | null;
  tssEstimate: number | null;
  intensityFactor: number | null;
  startDateMs: number;       // from start_date (UTC instant)
  localDate: string;         // YYYY-MM-DD from start_date_local (athlete wall-clock)
}

function activityCore(a: Record<string, unknown>, ftpWatts: number | null): ActivityCore {
  const movingSec = Number(a.moving_time ?? 0);
  const np = a.weighted_average_watts != null ? Math.round(Number(a.weighted_average_watts)) : null;
  const avgW = a.average_watts != null ? Math.round(Number(a.average_watts)) : null;
  const kj = a.kilojoules != null ? Math.round(Number(a.kilojoules)) : null;

  // TSS estimate: (t_s * NP * IF) / (FTP * 3600) * 100 — only when power + FTP known
  let tssEstimate: number | null = null;
  let intensityFactor: number | null = null;
  if (np && ftpWatts && ftpWatts > 0) {
    intensityFactor = parseFloat((np / ftpWatts).toFixed(2));
    tssEstimate = Math.round((movingSec * np * intensityFactor) / (ftpWatts * 3600) * 100);
  }

  const startDateMs = a.start_date ? new Date(String(a.start_date)).getTime() : Date.now();
  const localRaw = a.start_date_local
    ? String(a.start_date_local)
    : a.start_date
      ? String(a.start_date)
      : '';

  return {
    type: String(a.sport_type ?? a.type ?? 'Unknown'),
    name: typeof a.name === 'string' ? a.name : '',
    movingSec,
    durationMin: Math.round(movingSec / 60),
    distanceKm: parseFloat((Number(a.distance ?? 0) / 1000).toFixed(1)),
    elevationM: a.total_elevation_gain != null ? Math.round(Number(a.total_elevation_gain)) : null,
    avgWatts: avgW,
    normalizedWatts: np,
    kilojoules: kj,
    avgHr: a.average_heartrate != null ? Math.round(Number(a.average_heartrate)) : null,
    maxHr: a.max_heartrate != null ? Math.round(Number(a.max_heartrate)) : null,
    avgSpeedKmh: a.average_speed != null ? parseFloat((Number(a.average_speed) * 3.6).toFixed(1)) : null,
    sufferScore: a.suffer_score != null ? Math.round(Number(a.suffer_score)) : null,
    tssEstimate,
    intensityFactor,
    startDateMs,
    localDate: localRaw.slice(0, 10),
  };
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
    const accessToken = await ensureAccessToken(userId, encAccessToken, encRefreshToken, tokenExpiresAt);
    if (!accessToken) return null;

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
      const core = activityCore(a, ftpWatts);
      return {
        type: core.type,
        daysBeforeRace: Math.round((raceDateMs - core.startDateMs) / 86400000),
        durationMin: core.durationMin,
        distanceKm: core.distanceKm,
        elevationM: core.elevationM,
        avgWatts: core.avgWatts,
        normalizedWatts: core.normalizedWatts,
        kilojoules: core.kilojoules,
        avgHr: core.avgHr,
        maxHr: core.maxHr,
        avgSpeedKmh: core.avgSpeedKmh,
        sufferScore: core.sufferScore,
        tssEstimate: core.tssEstimate,
        intensityFactor: core.intensityFactor,
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

// ── Date helpers (UTC-stable; independent of server timezone) ────────────────

function shiftDate(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function weekdayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

// ── Training snapshot fetch (last 2 weeks, relative to NOW) ───────────────────
// Powers the live "your last 2 weeks" panel on the plan page. Keyed to the
// current date (not the race date). Never throws — returns null on any failure
// so the plan page degrades gracefully. Returns a zeroed snapshot (rather than
// null) when the athlete simply hasn't trained, so we can show a rest state.

const SNAPSHOT_DAYS = 14;

export async function fetchStravaTrainingSnapshot(
  userId: string,
  encAccessToken: string | null,
  encRefreshToken: string | null,
  tokenExpiresAt: string | null,
  ftpWatts: number | null,
): Promise<StravaTrainingSnapshot | null> {
  if (!encAccessToken || !encRefreshToken) return null;

  try {
    const accessToken = await ensureAccessToken(userId, encAccessToken, encRefreshToken, tokenExpiresAt);
    if (!accessToken) return null;

    const nowMs = Date.now();
    const windowStartMs = nowMs - SNAPSHOT_DAYS * 86400000;
    const afterSec = Math.floor(windowStartMs / 1000);

    // per_page=100 covers 2 weeks even for high-volume athletes
    const url = `${ACTIVITIES_URL}?after=${afterSec}&per_page=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      console.error('Strava snapshot fetch failed', { userId, status: res.status });
      return null;
    }

    const raw = await res.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(raw)) return null;

    // Map + clamp to the window (Strava 'after' is inclusive; double-guard),
    // most recent first.
    const cores = raw
      .map((a) => activityCore(a, ftpWatts))
      .filter((c) => c.startDateMs >= windowStartMs)
      .sort((a, b) => b.startDateMs - a.startDateMs);

    const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
    // End the window at whichever is later: today, or the most recent activity's
    // local date — guards against TZ skew hiding a session done late today.
    const rangeEnd = cores.reduce((max, c) => (c.localDate > max ? c.localDate : max), todayUtc);
    const rangeStart = shiftDate(rangeEnd, -(SNAPSHOT_DAYS - 1));

    // 14 daily buckets, oldest → newest.
    const dayMap = new Map<string, DailyLoad>();
    for (let i = 0; i < SNAPSHOT_DAYS; i++) {
      const date = shiftDate(rangeStart, i);
      dayMap.set(date, { date, label: weekdayLabel(date), tss: 0, hours: 0, sessions: 0 });
    }
    for (const c of cores) {
      const bucket = dayMap.get(c.localDate);
      if (!bucket) continue;
      bucket.sessions += 1;
      bucket.hours = parseFloat((bucket.hours + c.durationMin / 60).toFixed(2));
      bucket.tss += c.tssEstimate ?? 0;
    }
    const daily = Array.from(dayMap.values());

    // Sport breakdown, sorted by hours desc.
    const sportMap = new Map<string, SportBreakdown>();
    for (const c of cores) {
      const s = sportMap.get(c.type) ?? { type: c.type, sessions: 0, hours: 0, tss: null };
      s.sessions += 1;
      s.hours = parseFloat((s.hours + c.durationMin / 60).toFixed(1));
      if (c.tssEstimate != null) s.tss = (s.tss ?? 0) + c.tssEstimate;
      sportMap.set(c.type, s);
    }
    const sports = Array.from(sportMap.values()).sort((a, b) => b.hours - a.hours);

    // Totals.
    const anyTss = cores.some((c) => c.tssEstimate != null);
    const totalMin = cores.reduce((s, c) => s + c.durationMin, 0);
    const totals = {
      sessions: cores.length,
      hours: parseFloat((totalMin / 60).toFixed(1)),
      tss: anyTss ? Math.round(cores.reduce((s, c) => s + (c.tssEstimate ?? 0), 0)) : null,
      kj: cores.some((c) => c.kilojoules != null)
        ? Math.round(cores.reduce((s, c) => s + (c.kilojoules ?? 0), 0))
        : null,
      distanceKm: parseFloat(cores.reduce((s, c) => s + c.distanceKm, 0).toFixed(1)),
      elevationM: Math.round(cores.reduce((s, c) => s + (c.elevationM ?? 0), 0)),
      activeDays: new Set(cores.map((c) => c.localDate)).size,
    };

    // This week (last 7 days) vs previous week (days 7–13).
    const weekMs = 7 * 86400000;
    const sumWindow = (loMs: number, hiMs: number) => {
      const inWin = cores.filter((c) => c.startDateMs >= loMs && c.startDateMs < hiMs);
      const tss = inWin.some((c) => c.tssEstimate != null)
        ? Math.round(inWin.reduce((s, c) => s + (c.tssEstimate ?? 0), 0))
        : null;
      return {
        tss,
        hours: parseFloat((inWin.reduce((s, c) => s + c.durationMin, 0) / 60).toFixed(1)),
        sessions: inWin.length,
      };
    };
    const thisWeek = sumWindow(nowMs - weekMs, nowMs + 1);
    const prevWeek = sumWindow(nowMs - 2 * weekMs, nowMs - weekMs);

    // Ramp: prefer TSS; fall back to hours when there's no power data.
    let rampPct: number | null = null;
    if (thisWeek.tss != null && prevWeek.tss != null && prevWeek.tss > 0) {
      rampPct = Math.round(((thisWeek.tss - prevWeek.tss) / prevWeek.tss) * 100);
    } else if (prevWeek.hours > 0) {
      rampPct = Math.round(((thisWeek.hours - prevWeek.hours) / prevWeek.hours) * 100);
    }

    const daysSinceLastWorkout = cores.length
      ? Math.floor((nowMs - cores[0].startDateMs) / 86400000)
      : null;

    const longest = cores.reduce<ActivityCore | null>(
      (max, c) => (!max || c.durationMin > max.durationMin ? c : max),
      null,
    );
    const longestSession = longest
      ? { type: longest.type, durationMin: longest.durationMin, distanceKm: longest.distanceKm }
      : null;

    const activities: SnapshotActivity[] = cores.map((c) => ({
      type: c.type,
      name: c.name,
      date: c.localDate,
      daysAgo: Math.floor((nowMs - c.startDateMs) / 86400000),
      durationMin: c.durationMin,
      distanceKm: c.distanceKm,
      elevationM: c.elevationM,
      avgWatts: c.avgWatts,
      normalizedWatts: c.normalizedWatts,
      avgHr: c.avgHr,
      avgSpeedKmh: c.avgSpeedKmh,
      tss: c.tssEstimate,
      intensityFactor: c.intensityFactor,
      kilojoules: c.kilojoules,
    }));

    return {
      generatedAt: new Date(nowMs).toISOString(),
      rangeStart,
      rangeEnd,
      ftpUsed: ftpWatts,
      hasPower: cores.some((c) => c.normalizedWatts != null),
      totals,
      thisWeek,
      prevWeek,
      rampPct,
      daysSinceLastWorkout,
      longestSession,
      daily,
      sports,
      activities,
    };
  } catch (err) {
    console.error('Strava snapshot error', { userId, error: (err as Error).message });
    return null;
  }
}
