import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import { admin, getDb, getAuth, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate input ──────────────────────────────────────────────────
  const { uid, email, name } = req.body || {};

  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid uid' });
  }
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid email' });
  }

  // ── Verify user exists in Firebase Auth ─────────────────────────────
  try {
    await getAuth().getUser(uid);
  } catch {
    return res.status(403).json({ error: 'Invalid user' });
  }

  // ── Validate Razorpay env vars ──────────────────────────────────────
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const planId = process.env.RAZORPAY_PLAN_ID;

  if (!keyId || !keySecret || !planId) {
    console.error('Missing Razorpay env vars');
    return res.status(500).json({ error: 'Payment service misconfigured' });
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  try {
    // ── Check for existing active subscription ──────────────────────
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.data();
    const existingSub = userData?.subscription;

    if (existingSub?.status === 'active' && existingSub?.plan === 'pro') {
      return res.status(400).json({ error: 'Already subscribed', plan: 'pro' });
    }

    // ── Determine trial eligibility ─────────────────────────────────
    const isFirstTime = !existingSub || (existingSub.plan === 'free' && !existingSub.grantedBy);
    const trialDays = isFirstTime ? 2 : 0;

    // ── Build Razorpay subscription options ──────────────────────────
    const subscriptionOptions: Record<string, unknown> = {
      plan_id: planId,
      total_count: 120, // Max 10 years of monthly billing
      quantity: 1,
      notes: {
        firebase_uid: uid,
        email,
        name: name || '',
      },
    };

    if (trialDays > 0) {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      subscriptionOptions.start_at = Math.floor(trialEnd.getTime() / 1000);
    }

    // ── Create Razorpay subscription FIRST (before writing to Firestore)
    // This prevents a race condition where trial is written but Razorpay fails.
    const subscription = await razorpay.subscriptions.create(subscriptionOptions);

    // ── Write to Firestore only AFTER Razorpay succeeds ─────────────
    const updateData: Record<string, unknown> = {
      'subscription.razorpaySubscriptionId': subscription.id,
    };

    if (trialDays > 0) {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      Object.assign(updateData, {
        'subscription.plan': 'trial',
        'subscription.status': 'trialing',
        'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
        'subscription.trialEndDate': admin.firestore.Timestamp.fromDate(trialEnd),
        'subscription.endDate': admin.firestore.Timestamp.fromDate(trialEnd),
        'subscription.grantedBy': 'trial',
        'aiLimit': 50000,
        'aiEnabled': true,
      });
    }

    await getDb().collection('users').doc(uid).update(updateData);

    return res.status(200).json({
      subscriptionId: subscription.id,
      razorpayKeyId: keyId,
      trialDays,
    });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
