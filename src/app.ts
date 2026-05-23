import express from 'express';
import cors from 'cors';

const isDev = process.env.NODE_ENV !== 'production';

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: isDev
    ? /^http:\/\/localhost(:\d+)?$/
    : (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()),
  credentials: true,
}));

// ── Stripe webhook must receive raw body — register BEFORE express.json() ─────
// app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// ── JSON body parser for all other routes ─────────────────────────────────────
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Routes (add as features are built) ───────────────────────────────────────
// app.use('/api/auth',     authRoutes);
// app.use('/api/plans',    planRoutes);
// app.use('/api/payments', paymentRoutes);

export default app;
