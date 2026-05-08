import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import admin from 'firebase-admin';

// Initialize Firebase Admin (singleton)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid, email, name } = req.body;

  if (!uid || !email) {
    return res.status(400).json({ error: 'Missing uid or email' });
  }

  // Verify user exists in Firebase
  try {
    await admin.auth().getUser(uid);
  } catch {
    return res.status(403).json({ error: 'Invalid user' });
  }

  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  });

  try {
    // Check if user already has an active subscription
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();
    const existingSub = userData?.subscription;

    if (existingSub?.status === 'active' && existingSub?.plan === 'pro') {
      return res.status(400).json({ error: 'Already subscribed', plan: 'pro' });
    }

    // Check trial eligibility
    const isFirstTime = !existingSub || (existingSub.plan === 'free' && !existingSub.grantedBy);
    const trialDays = isFirstTime ? 2 : 0;

    // Create Razorpay subscription
    const subscriptionOptions: any = {
      plan_id: process.env.RAZORPAY_PLAN_ID!,
      total_count: 120, // Max 10 years of monthly billing
      quantity: 1,
      notes: {
        firebase_uid: uid,
        email: email,
        name: name || '',
      },
    };

    // Add trial period for first-time users (2 days)
    if (trialDays > 0) {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      subscriptionOptions.start_at = Math.floor(trialEnd.getTime() / 1000);

      // Mark trial in Firestore immediately
      await db.collection('users').doc(uid).update({
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

    const subscription = await razorpay.subscriptions.create(subscriptionOptions);

    // Store subscription ID
    await db.collection('users').doc(uid).update({
      'subscription.razorpaySubscriptionId': subscription.id,
    });

    return res.status(200).json({
      subscriptionId: subscription.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      trialDays,
    });
  } catch (error: any) {
    console.error('Create subscription error:', error);
    return res.status(500).json({
      error: 'Failed to create subscription',
      details: error.message,
    });
  }
}
