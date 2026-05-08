import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import admin from 'firebase-admin';

try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} catch (e) {
  console.error('Firebase init error:', e);
}

function getDb() { return admin.firestore(); }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' });
  }

  try {
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.data();
    const subscriptionId = userData?.subscription?.razorpaySubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });

    // Cancel at end of current billing cycle (not immediately)
    await (razorpay.subscriptions as any).cancel(subscriptionId, true);

    // Update Firestore — user keeps Pro until endDate
    await getDb().collection('users').doc(uid).update({
      'subscription.status': 'cancelled',
      'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ status: 'cancelled', message: 'Subscription will end at current period.' });
  } catch (error: any) {
    console.error('Cancel subscription error:', error);
    return res.status(500).json({ error: 'Failed to cancel', details: error.message });
  }
}
