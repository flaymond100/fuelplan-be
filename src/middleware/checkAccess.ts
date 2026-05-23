import { Request, Response, NextFunction } from 'express';
import { supabaseService } from '../config/supabase.js';

function addOneMonth(date: Date): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

async function checkPlanAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.user!.id;

  const [{ data: sub }, { data: credits }] = await Promise.all([
    supabaseService.from('subscriptions').select('plan, status, current_period_end').eq('user_id', userId).single(),
    supabaseService.from('plan_credits').select('credits, used_this_month, reset_at').eq('user_id', userId).single(),
  ]);

  // Pro — active subscription
  if (sub?.plan === 'pro' && sub.status === 'active') return next();

  // Pay-per-plan — has credits
  if (sub?.plan === 'pay_per_plan' && (credits?.credits ?? 0) > 0) return next();

  // Free — 1 plan/month
  if (!sub || sub.plan === 'free') {
    const now = new Date();
    const resetAt = credits?.reset_at ? new Date(credits.reset_at) : null;
    if (!resetAt || resetAt < now) {
      await supabaseService.from('plan_credits')
        .update({ used_this_month: 0, reset_at: addOneMonth(now).toISOString() })
        .eq('user_id', userId);
    }
    if ((credits?.used_this_month ?? 0) < 1) return next();
  }

  res.status(403).json({ error: 'Plan limit reached. Upgrade to generate more plans.' });
}

export { checkPlanAccess };
