import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' });
  }

  try {
    // Verify the user exists in Firebase Auth
    await admin.auth().getUser(uid);

    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();

    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    const sub = userData.subscription || {};
    const plan = sub.plan || 'free';
    const status = sub.status || 'none';
    const endDate = sub.endDate?.toDate?.() || null;
    const trialEndDate = sub.trialEndDate?.toDate?.() || null;

    // Auto-expire overdue subscriptions
    if (endDate && new Date() > endDate && (status === 'active' || status === 'trialing')) {
      await db.collection('users').doc(uid).update({
        'subscription.plan': 'free',
        'subscription.status': 'expired',
        'aiLimit': 15000,
      });

      return res.status(200).json({
        plan: 'free',
        status: 'expired',
        endDate: endDate?.toISOString() || null,
        isPro: false,
      });
    }

    const isPro = (plan === 'pro' || plan === 'trial') &&
      (!endDate || new Date() <= endDate);

    return res.status(200).json({
      plan,
      status,
      endDate: endDate?.toISOString() || null,
      trialEndDate: trialEndDate?.toISOString() || null,
      grantedBy: sub.grantedBy || null,
      isPro,
      dailyTokenLimit: isPro ? 50000 : 15000,
    });
  } catch (error: any) {
    console.error('Check subscription error:', error);
    return res.status(500).json({ error: 'Failed to check subscription', details: error.message });
  }
}
