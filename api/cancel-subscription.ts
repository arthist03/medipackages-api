import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import { admin, getDb, getAuth, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.status(500).json({ error: 'Payment service misconfigured' });
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  try {
    const userRef = getDb().collection('users').doc(uid);
    const userDoc = await userRef.get();
    const sub = userDoc.data()?.subscription;

    if (!sub || !sub.razorpaySubscriptionId) {
      return res.status(400).json({ error: 'No active Razorpay subscription found' });
    }

    if (sub.status === 'cancelled') {
      return res.status(400).json({ error: 'Subscription is already cancelled' });
    }

    // Cancel in Razorpay immediately so they are never charged again
    try {
      await razorpay.subscriptions.cancel(sub.razorpaySubscriptionId, false);
    } catch (rzpError: any) {
      console.warn('Razorpay cancel error or already cancelled:', rzpError);
    }

    // Update Firestore to mark as cancelled
    // The user keeps access until the existing endDate in the database is reached
    await userRef.update({
      'subscription.status': 'cancelled',
      'subscription.plan': 'free',
      'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
      'aiEnabled': false,
      'aiLimit': 10000,
    });

    return res.status(200).json({ status: 'cancelled' });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
