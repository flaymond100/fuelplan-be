import { anthropic } from '../config/anthropic.js';
import type { GpxParseResult } from './gpxParser.js';

// ── Plan JSON types (decision 0003) ─────────────────────────────────────────

export interface NutrientTotals {
  carbsG: number;
  fluidsMl: number;
  sodiumMg: number;
  caffeineMg: number;
  kcal: number;
}

export interface PlanItem {
  offsetMin: number;
  label: string;
  what: string;
  carbsG: number;
  fatG: number;
  proteinG: number;
  fluidsMl: number;
  sodiumMg: number;
  caffeineMg: number;
  kcal: number;
  notes: string | null;
}

export type PhaseId =
  | 'pre_race_d3'
  | 'pre_race_d2'
  | 'pre_race_d1'
  | 'pre_race_morning'
  | 'race'
  | 'recovery';

export interface PlanPhase {
  id: PhaseId;
  label: string;
  startOffsetMin: number;
  endOffsetMin: number;
  totals: NutrientTotals;
  items: PlanItem[];
}

export interface PlanJson {
  schemaVersion: 1;
  summary: string;
  estimatedDurationMin: number;
  totals: NutrientTotals;
  phases: PlanPhase[];
  warnings: string[];
}

// ── Athlete profile (subset of profiles table used for prompting) ────────────

export interface AthleteProfile {
  weight_kg: number | null;
  sex: string | null;
  birth_date: string | null;
  disciplines: string[];
  ftp_watts: number | null;
  running_threshold_sec_per_km: number | null;
  max_hr: number | null;
  weekly_training_hours: number | null;
  sweat_rate: string | null;
  max_carbs_g_hr: number | null;
  caffeine_tolerance: string | null;
  fuel_forms: string[];
  diet: string | null;
  restrictions: string[];
  restrictions_other: string | null;
  avoid_notes: string | null;
}

// ── Input params mirroring the FE payload ────────────────────────────────────

export interface GenerationParams {
  raceName: string;
  raceDate: string;
  startTime: string;
  discipline: string;
  effortLevel: string;
  targetFinishTime: string;
  aidStations: string;
  planWindow: '24h' | '48h' | '72h';
  carbsOverride: number | null;
  caffeine: string;
  weather: {
    tempMaxC: number;
    tempMinC: number;
    precipitationProbabilityPct: number;
    windSpeedMaxKmh: number;
    weatherCode: number;
  } | null;
  gpxMeta: { startLat: number; startLng: number; pointCount: number };
  canonical: GpxParseResult;
  profile: AthleteProfile;
}

// ── Prompt construction ───────────────────────────────────────────────────────

const PHASE_MAP: Record<string, string[]> = {
  '24h': ['pre_race_d1', 'pre_race_morning', 'race', 'recovery'],
  '48h': ['pre_race_d2', 'pre_race_d1', 'pre_race_morning', 'race', 'recovery'],
  '72h': ['pre_race_d3', 'pre_race_d2', 'pre_race_d1', 'pre_race_morning', 'race', 'recovery'],
};

function ageFromBirthDate(birthDate: string | null): string {
  if (!birthDate) return 'unknown';
  const today = new Date();
  const dob = new Date(birthDate);
  const age = today.getFullYear() - dob.getFullYear();
  return String(age);
}

function paceFromSecPerKm(secPerKm: number | null): string {
  if (!secPerKm) return 'unknown';
  const min = Math.floor(secPerKm / 60);
  const sec = secPerKm % 60;
  return `${min}:${String(sec).padStart(2, '0')}/km`;
}

function buildPrompt(p: GenerationParams): string {
  const { profile, canonical } = p;
  const phases = PHASE_MAP[p.planWindow].join(', ');
  const carbsPerHr = p.carbsOverride ?? profile.max_carbs_g_hr ?? 60;

  const weatherStr = p.weather
    ? `Max ${p.weather.tempMaxC}°C / Min ${p.weather.tempMinC}°C, precipitation ${p.weather.precipitationProbabilityPct}%, wind ${p.weather.windSpeedMaxKmh} km/h`
    : 'Not available (race >16 days out or no location data)';

  return `Create a personalised race nutrition plan with the following details.

## Athlete Profile
- Weight: ${profile.weight_kg != null ? `${profile.weight_kg} kg` : 'unknown'}
- Sex: ${profile.sex ?? 'unknown'}
- Age: ~${ageFromBirthDate(profile.birth_date)}
- Disciplines: ${profile.disciplines.join(', ') || 'unknown'}
- FTP: ${profile.ftp_watts != null ? `${profile.ftp_watts} W` : 'unknown'}
- Running threshold pace: ${paceFromSecPerKm(profile.running_threshold_sec_per_km)}
- Max HR: ${profile.max_hr != null ? `${profile.max_hr} bpm` : 'unknown'}
- Weekly training hours: ${profile.weekly_training_hours != null ? `${profile.weekly_training_hours} h` : 'unknown'}
- Sweat rate: ${profile.sweat_rate ?? 'medium'}
- Max carbs per hour (gut-trained): ${profile.max_carbs_g_hr != null ? `${profile.max_carbs_g_hr} g/hr` : 'unknown'}
- Caffeine tolerance: ${profile.caffeine_tolerance ?? 'unknown'}
- Preferred fuel forms: ${profile.fuel_forms.join(', ') || 'any'}
- Diet: ${profile.diet ?? 'omnivore'}
- Dietary restrictions: ${profile.restrictions.join(', ') || 'none'}${profile.restrictions_other ? `, ${profile.restrictions_other}` : ''}
- Avoid/notes: ${profile.avoid_notes || 'none'}

## Race Details
- Name: ${p.raceName}
- Date: ${p.raceDate}
- Discipline: ${p.discipline || 'running'}
- Distance (canonical from GPX): ${canonical.distanceKm} km
- Elevation gain (canonical from GPX, smoothed): ${canonical.elevationGainM} m
- Start time: ${p.startTime || 'not specified'}
- Effort level: ${p.effortLevel || 'race_pace'}
- Target finish time: ${p.targetFinishTime || 'not specified — estimate based on distance and effort'}

## Plan Parameters
- Plan window: ${p.planWindow} — generate exactly these phases in this order: ${phases}
- Aid stations: ${p.aidStations || 'frequent'} (use this to set race fuelling frequency)
- Carbs per hour during race: ${carbsPerHr} g/hr
- Caffeine strategy: ${p.caffeine || 'standard'}

## Race Day Weather
${weatherStr}

## Output Schema
Return ONLY a valid JSON object — no markdown fences, no explanation, no text before or after the JSON.

{
  "schemaVersion": 1,
  "summary": "<1–2 sentence overview of the plan>",
  "estimatedDurationMin": <integer — match targetFinishTime if given; estimate if blank>,
  "totals": { "carbsG": <int>, "fluidsMl": <int>, "sodiumMg": <int>, "caffeineMg": <int>, "kcal": <int> },
  "phases": [
    {
      "id": "<one of: pre_race_d3 | pre_race_d2 | pre_race_d1 | pre_race_morning | race | recovery>",
      "label": "<human-readable phase name>",
      "startOffsetMin": <int; negative = minutes before race start>,
      "endOffsetMin": <int>,
      "totals": { "carbsG": <int>, "fluidsMl": <int>, "sodiumMg": <int>, "caffeineMg": <int>, "kcal": <int> },
      "items": [
        {
          "offsetMin": <int; negative = before start, 0 = race start, positive = after start>,
          "label": "<meal/event name e.g. Breakfast | Lunch | Pre-race snack | Aid station 3 | Recovery shake>",
          "what": "<specific food/drink description with rough quantities>",
          "carbsG": <int>,
          "fat": <int>,
          "protein": <int>,
          "fluidsMl": <int>,
          "sodiumMg": <int>,
          "caffeineMg": <int>,
          "kcal": <int>,
          "notes": "<practical tip, or null>"
        }
      ]
    }
  ],
  "warnings": ["<string — only include if genuinely relevant, e.g. carb tolerance mismatch, heat risk, caffeine caveat>"]
}

Rules:
- totals fields must be non-negative integers.
- phase totals must equal the sum of their items' corresponding fields.
- top-level totals must equal the sum across all phases.
- offsetMin values within a phase must be within [startOffsetMin, endOffsetMin).
- The "race" phase starts at offsetMin 0 (race start) and ends at estimatedDurationMin.
- The "recovery" phase starts immediately after the race ends.
- Provide at least 3 items per phase; aim for a realistic, practical plan rather than an exhaustive one.
- Do not suggest foods the athlete must avoid. Respect dietary restrictions strictly.`;
}

// ── Response validation ───────────────────────────────────────────────────────

function assertNumber(val: unknown, path: string): number {
  if (typeof val !== 'number' || !isFinite(val)) {
    throw new Error(`${path} must be a finite number, got ${JSON.stringify(val)}`);
  }
  return val;
}

function assertString(val: unknown, path: string): string {
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(`${path} must be a non-empty string, got ${JSON.stringify(val)}`);
  }
  return val;
}

function validateTotals(val: unknown, path: string): NutrientTotals {
  if (typeof val !== 'object' || val === null) throw new Error(`${path} must be an object`);
  const t = val as Record<string, unknown>;
  return {
    carbsG: Math.round(assertNumber(t.carbsG, `${path}.carbsG`)),
    fluidsMl: Math.round(assertNumber(t.fluidsMl, `${path}.fluidsMl`)),
    sodiumMg: Math.round(assertNumber(t.sodiumMg, `${path}.sodiumMg`)),
    caffeineMg: Math.round(assertNumber(t.caffeineMg, `${path}.caffeineMg`)),
    kcal: Math.round(assertNumber(t.kcal, `${path}.kcal`)),
  };
}

function validateItem(val: unknown, path: string): PlanItem {
  if (typeof val !== 'object' || val === null) throw new Error(`${path} must be an object`);
  const i = val as Record<string, unknown>;
  return {
    offsetMin: Math.round(assertNumber(i.offsetMin, `${path}.offsetMin`)),
    label: assertString(i.label, `${path}.label`),
    what: assertString(i.what, `${path}.what`),
    carbsG: Math.round(assertNumber(i.carbsG, `${path}.carbsG`)),
    fatG: Math.round(assertNumber(i.fat, `${path}.fat`)),
    proteinG: Math.round(assertNumber(i.protein, `${path}.protein`)),
    fluidsMl: Math.round(assertNumber(i.fluidsMl, `${path}.fluidsMl`)),
    sodiumMg: Math.round(assertNumber(i.sodiumMg, `${path}.sodiumMg`)),
    caffeineMg: Math.round(assertNumber(i.caffeineMg, `${path}.caffeineMg`)),
    kcal: Math.round(assertNumber(i.kcal, `${path}.kcal`)),
    notes: typeof i.notes === 'string' && i.notes.trim() !== '' ? i.notes : null,
  };
}

const VALID_PHASE_IDS = new Set<string>([
  'pre_race_d3', 'pre_race_d2', 'pre_race_d1', 'pre_race_morning', 'race', 'recovery',
]);

function validatePhase(val: unknown, idx: number): PlanPhase {
  if (typeof val !== 'object' || val === null) throw new Error(`phases[${idx}] must be an object`);
  const ph = val as Record<string, unknown>;

  const id = assertString(ph.id, `phases[${idx}].id`);
  if (!VALID_PHASE_IDS.has(id)) throw new Error(`phases[${idx}].id "${id}" is not a valid phase id`);

  if (!Array.isArray(ph.items) || ph.items.length === 0) {
    throw new Error(`phases[${idx}].items must be a non-empty array`);
  }

  return {
    id: id as PhaseId,
    label: assertString(ph.label, `phases[${idx}].label`),
    startOffsetMin: Math.round(assertNumber(ph.startOffsetMin, `phases[${idx}].startOffsetMin`)),
    endOffsetMin: Math.round(assertNumber(ph.endOffsetMin, `phases[${idx}].endOffsetMin`)),
    totals: validateTotals(ph.totals, `phases[${idx}].totals`),
    items: ph.items.map((item, j) => validateItem(item, `phases[${idx}].items[${j}]`)),
  };
}

function validatePlanJson(raw: unknown): PlanJson {
  if (typeof raw !== 'object' || raw === null) throw new Error('plan_json is not an object');
  const d = raw as Record<string, unknown>;

  if (d.schemaVersion !== 1) throw new Error(`unexpected schemaVersion: ${d.schemaVersion}`);

  const summary = assertString(d.summary, 'summary');
  const estimatedDurationMin = Math.round(assertNumber(d.estimatedDurationMin, 'estimatedDurationMin'));
  if (estimatedDurationMin <= 0) throw new Error('estimatedDurationMin must be positive');

  const totals = validateTotals(d.totals, 'totals');

  if (!Array.isArray(d.phases) || d.phases.length === 0) {
    throw new Error('phases must be a non-empty array');
  }
  const phases = d.phases.map((ph, i) => validatePhase(ph, i));

  if (!Array.isArray(d.warnings)) throw new Error('warnings must be an array');
  const warnings = d.warnings.filter((w): w is string => typeof w === 'string');

  return { schemaVersion: 1, summary, estimatedDurationMin, totals, phases, warnings };
}

// ── Main entry point ─────────────────────────────────────────────────────────

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_MAX_TOKENS = 4096;
const CLAUDE_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are an expert endurance sports nutritionist specialising in race-day fuelling strategies for cyclists and runners. You create detailed, evidence-based, personalised nutrition plans.

Your output MUST be a single valid JSON object matching the schema the user specifies. Do not include markdown code fences, preambles, or any text outside the JSON object. Return ONLY the raw JSON.`;

export async function generatePlan(params: GenerationParams): Promise<PlanJson> {
  const prompt = buildPrompt(params);

  const response = await anthropic.messages.create(
    {
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: CLAUDE_TIMEOUT_MS },
  );

  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('');

  // Strip markdown code fences if Claude misbehaves
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Claude returned non-JSON response: ${(err as Error).message}`);
  }

  return validatePlanJson(parsed);
}
