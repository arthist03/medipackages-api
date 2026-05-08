import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import { getDb, getAuth, admin, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate input ──────────────────────────────────────────────────
  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid uid' });
  }

  // ── Verify user exists in Firebase Auth ─────────────────────────────
  try {
    await getAuth().getUser(uid);
  } catch {
    return res.status(403).json({ error: 'Invalid user' });
  }

  try {
    // ── Read subscription data ────────────────────────────────────────
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.data();
    const subscriptionId = userData?.subscription?.razorpaySubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }

    // ── Check subscription status before cancelling ───────────────────
    const currentStatus = userData?.subscription?.status;
    if (currentStatus === 'cancelled' || currentStatus === 'expired') {
      return res.status(400).json({ error: `Subscription already ${currentStatus}` });
    }

    // ── Validate Razorpay env vars ────────────────────────────────────
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      console.error('Missing Razorpay env vars');
      return res.status(500).json({ error: 'Payment service misconfigured' });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    // ── Cancel at end of current billing cycle (not immediately) ──────
    await (razorpay.subscriptions as any).cancel(subscriptionId, true);

    // ── Update Firestore — user keeps Pro until endDate ───────────────
    await getDb().collection('users').doc(uid).update({
      'subscription.status': 'cancelled',
      'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      status: 'cancelled',
      message: 'Subscription will end at current period.',
    });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
