import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, getAuth, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate input ──────────────────────────────────────────────────
  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid uid' });
  }

  try {
    // ── Verify user exists in Firebase Auth ───────────────────────────
    await getAuth().getUser(uid);

    // ── Read user's subscription data ─────────────────────────────────
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.data();

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sub = userData.subscription || {};
    const plan: string = sub.plan || 'free';
    const status: string = sub.status || 'none';
    const endDate: Date | null = sub.endDate?.toDate?.() ?? null;
    const trialEndDate: Date | null = sub.trialEndDate?.toDate?.() ?? null;

    // ── Auto-expire overdue subscriptions ──────────────────────────────
    if (endDate && new Date() > endDate && (status === 'active' || status === 'trialing')) {
      await getDb().collection('users').doc(uid).update({
        'subscription.plan': 'free',
        'subscription.status': 'expired',
        'aiLimit': 15000,
      });

      return res.status(200).json({
        plan: 'free',
        status: 'expired',
        endDate: endDate.toISOString(),
        isPro: false,
        dailyTokenLimit: 15000,
      });
    }

    // ── Compute Pro status ────────────────────────────────────────────
    const isPro = (plan === 'pro' || plan === 'trial') &&
      (!endDate || new Date() <= endDate);

    return res.status(200).json({
      plan,
      status,
      endDate: endDate?.toISOString() ?? null,
      trialEndDate: trialEndDate?.toISOString() ?? null,
      grantedBy: sub.grantedBy ?? null,
      isPro,
      dailyTokenLimit: isPro ? 50000 : 15000,
    });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
