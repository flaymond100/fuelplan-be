import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate.js';
import { checkPlanAccess } from '../middleware/checkAccess.js';
import { parseGpxBuffer } from '../services/gpxParser.js';
import { generatePlan, type AthleteProfile, type GenerationParams } from '../services/planGenerator.js';
import { supabaseService } from '../config/supabase.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB — mirrors hard rule in gpxParser
});

// ── POST /api/plans/generate ─────────────────────────────────────────────────

router.post(
  '/generate',
  authenticate,
  checkPlanAccess,
  upload.single('gpxFile'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    // ── 1. Parse + validate request body ──────────────────────────────────
    let payload: Record<string, unknown>;
    try {
      payload =
        typeof req.body.payload === 'string'
          ? JSON.parse(req.body.payload)
          : req.body.payload ?? {};
    } catch {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'payload field is not valid JSON' } });
      return;
    }

    const raceName = typeof payload.raceName === 'string' ? payload.raceName.trim() : '';
    const raceDate = typeof payload.raceDate === 'string' ? payload.raceDate.trim() : '';
    const planWindow = payload.planWindow as string;

    if (!raceName) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'raceName is required' } });
      return;
    }
    if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate)) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'raceDate must be YYYY-MM-DD' } });
      return;
    }
    if (!['24h', '48h', '72h'].includes(planWindow)) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'planWindow must be 24h, 48h, or 72h' } });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'gpxFile is required' } });
      return;
    }

    // ── 2. Parse GPX server-side (canonical numbers) ──────────────────────
    let canonical: Awaited<ReturnType<typeof parseGpxBuffer>>;
    try {
      canonical = parseGpxBuffer(req.file.buffer);
    } catch (err) {
      res.status(400).json({
        error: { code: 'INVALID_GPX', message: (err as Error).message },
      });
      return;
    }

    // ── 3. Upload GPX to storage ──────────────────────────────────────────
    const planId = crypto.randomUUID();
    const gpxPath = `${userId}/${planId}.gpx`;

    const { error: uploadError } = await supabaseService.storage
      .from('gpx-files')
      .upload(gpxPath, req.file.buffer, { contentType: 'application/gpx+xml', upsert: false });

    if (uploadError) {
      console.error('GPX upload failed', { userId, planId, error: uploadError.message });
      res.status(500).json({ error: { code: 'STORAGE_ERROR', message: 'Failed to store GPX file' } });
      return;
    }

    // ── 4. Load athlete profile ───────────────────────────────────────────
    const { data: profileRow, error: profileError } = await supabaseService
      .from('profiles')
      .select(
        'weight_kg,sex,birth_date,disciplines,ftp_watts,running_threshold_sec_per_km,' +
        'max_hr,weekly_training_hours,sweat_rate,max_carbs_g_hr,caffeine_tolerance,' +
        'fuel_forms,diet,restrictions,restrictions_other,avoid_notes',
      )
      .eq('id', userId)
      .single();

    if (profileError || !profileRow) {
      console.error('Profile load failed', { userId, error: profileError?.message });
      res.status(500).json({ error: { code: 'PROFILE_ERROR', message: 'Failed to load athlete profile' } });
      return;
    }

    // ── 5. Build generation params and call Claude ────────────────────────
    const params: GenerationParams = {
      raceName,
      raceDate,
      startTime: typeof payload.startTime === 'string' ? payload.startTime : '',
      discipline: typeof payload.discipline === 'string' ? payload.discipline : '',
      effortLevel: typeof payload.effortLevel === 'string' ? payload.effortLevel : '',
      targetFinishTime: typeof payload.targetFinishTime === 'string' ? payload.targetFinishTime : '',
      aidStations: typeof payload.aidStations === 'string' ? payload.aidStations : '',
      planWindow: planWindow as GenerationParams['planWindow'],
      carbsOverride: typeof payload.carbsOverride === 'number' ? payload.carbsOverride : null,
      caffeine: typeof payload.caffeine === 'string' ? payload.caffeine : '',
      weather:
        payload.weather && typeof payload.weather === 'object'
          ? (payload.weather as GenerationParams['weather'])
          : null,
      gpxMeta:
        payload.gpx && typeof payload.gpx === 'object'
          ? (payload.gpx as GenerationParams['gpxMeta'])
          : { startLat: 0, startLng: 0, pointCount: canonical.pointCount },
      canonical,
      profile: profileRow as unknown as AthleteProfile,
    };

    let planJson: Awaited<ReturnType<typeof generatePlan>>;
    try {
      planJson = await generatePlan(params);
    } catch (err) {
      const msg = (err as Error).message;
      const isTimeout = msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('abort');
      console.error('Plan generation failed', { userId, planId, error: msg });
      res.status(isTimeout ? 504 : 500).json({
        error: {
          code: 'PLAN_GENERATION_FAILED',
          message: isTimeout
            ? 'Plan generation timed out — please try again'
            : 'Plan generation failed — please try again',
        },
      });
      return;
    }

    // ── 6. Insert plan row + decrement credit atomically ─────────────────
    const startTimeDb =
      typeof payload.startTime === 'string' && /^\d{2}:\d{2}$/.test(payload.startTime)
        ? payload.startTime
        : null;

    const requestParams = {
      discipline: params.discipline,
      effortLevel: params.effortLevel,
      targetFinishTime: params.targetFinishTime,
      aidStations: params.aidStations,
      planWindow: params.planWindow,
      carbsOverride: params.carbsOverride,
      caffeine: params.caffeine,
      weather: params.weather,
      gpxMeta: params.gpxMeta,
    };

    const { data: planRow, error: rpcError } = await supabaseService.rpc(
      'insert_plan_and_decrement_credit',
      {
        p_plan_id: planId,
        p_user_id: userId,
        p_race_name: raceName,
        p_race_date: raceDate,
        p_distance_km: canonical.distanceKm,
        p_elevation_m: canonical.elevationGainM,
        p_start_time: startTimeDb,
        p_gpx_file_path: gpxPath,
        p_plan_json: planJson,
        p_request_params: requestParams,
      },
    );

    if (rpcError) {
      console.error('Plan insert/credit RPC failed', { userId, planId, error: rpcError.message });
      const isCredits = rpcError.message?.includes('INSUFFICIENT_CREDITS');
      res.status(isCredits ? 402 : 500).json({
        error: {
          code: isCredits ? 'INSUFFICIENT_CREDITS' : 'DATABASE_ERROR',
          message: isCredits
            ? 'No credits remaining — please purchase more'
            : 'Failed to save plan',
        },
      });
      return;
    }

    res.status(201).json({ planId, plan: planRow });
  },
);

// ── GET /api/plans/:id/gpx ────────────────────────────────────────────────────
// Returns a short-lived signed URL to the stored GPX file.
// The gpx-files bucket is service-role-only so the FE can't read it directly.

router.get('/:id/gpx', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;

  const { data: plan, error } = await supabaseService
    .from('plans')
    .select('gpx_file_path')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !plan) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    return;
  }

  if (!plan.gpx_file_path) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No GPX file for this plan' } });
    return;
  }

  const { data: signed, error: signError } = await supabaseService.storage
    .from('gpx-files')
    .createSignedUrl(plan.gpx_file_path, 300); // 5-min TTL

  if (signError || !signed?.signedUrl) {
    console.error('GPX signed URL failed', { userId, planId: id, error: signError?.message });
    res.status(500).json({ error: { code: 'STORAGE_ERROR', message: 'Failed to create GPX URL' } });
    return;
  }

  res.json({ url: signed.signedUrl });
});

// ── GET /api/plans/:id ────────────────────────────────────────────────────────

router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id } = req.params;

  const { data, error } = await supabaseService
    .from('plans')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    return;
  }

  res.json(data);
});

export default router;
