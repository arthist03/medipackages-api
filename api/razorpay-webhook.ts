import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import admin from 'firebase-admin';

// Initialize Firebase Admin (singleton)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function grantPro(uid: string, subscriptionId: string, paymentId?: string) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30); // 30-day period

  await db.collection('users').doc(uid).update({
    'subscription.plan': 'pro',
    'subscription.status': 'active',
    'subscription.razorpaySubscriptionId': subscriptionId,
    'subscription.lastPaymentAt': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
    'subscription.grantedBy': 'payment',
    'aiEnabled': true,
    'aiLimit': 50000,
  });

  // Log subscription event
  await db.collection('subscriptions').add({
    uid,
    event: 'activated',
    plan: 'pro',
    amount: 9900,
    currency: 'INR',
    razorpaySubscriptionId: subscriptionId,
    razorpayPaymentId: paymentId || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(endDate),
  });

  // Send FCM notification
  await sendFCM(uid, '🎉 Subscription Active', "You're all set! Your subscription is active and premium features are unlocked.");
}

async function renewPro(uid: string, paymentId: string) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);

  await db.collection('users').doc(uid).update({
    'subscription.status': 'active',
    'subscription.lastPaymentAt': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
    'aiLimit': 50000,
  });

  await db.collection('subscriptions').add({
    uid,
    event: 'renewed',
    plan: 'pro',
    amount: 9900,
    razorpayPaymentId: paymentId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(endDate),
  });

  await sendFCM(uid, '✅ Subscription Renewed', 'Your subscription has been renewed successfully.');
}

async function revokePro(uid: string) {
  await db.collection('users').doc(uid).update({
    'subscription.plan': 'free',
    'subscription.status': 'expired',
    'aiLimit': 15000,
  });

  await db.collection('subscriptions').add({
    uid,
    event: 'expired',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendFCM(uid, 'Subscription Expired', 'Your subscription has expired. Premium features are now locked.');
}

async function markCancelled(uid: string) {
  await db.collection('users').doc(uid).update({
    'subscription.status': 'cancelled',
    'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendFCM(uid, 'Subscription Cancelled', 'Your subscription has been cancelled. You will retain access until the current period ends.');
}

async function sendFCM(uid: string, title: string, body: string) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    const data = userDoc.data();
    const fcmToken = data?.fcmToken;
    if (!fcmToken) return;

    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: { type: 'subscription_update' },
      android: { notification: { icon: 'not_icon', color: '#0052D4' } },
    });
  } catch (e) {
    console.error('FCM send error:', e);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Razorpay webhook signature
  const signature = req.headers['x-razorpay-signature'] as string;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

  if (!signature || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or secret' });
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  const payload = req.body.payload;

  // Extract UID from subscription notes
  const subscriptionEntity = payload?.subscription?.entity;
  const paymentEntity = payload?.payment?.entity;
  const notes = subscriptionEntity?.notes || paymentEntity?.notes || {};
  const uid = notes.firebase_uid;

  if (!uid) {
    console.error('No firebase_uid in webhook notes:', JSON.stringify(notes));
    return res.status(200).json({ status: 'ok', message: 'No UID — skipped' });
  }

  try {
    switch (event) {
      case 'subscription.activated':
        await grantPro(uid, subscriptionEntity?.id, paymentEntity?.id);
        break;

      case 'subscription.charged':
        await renewPro(uid, paymentEntity?.id);
        break;

      case 'subscription.halted':
      case 'subscription.completed':
        await revokePro(uid);
        break;

      case 'subscription.cancelled':
        await markCancelled(uid);
        break;

      case 'subscription.pending':
        // No action needed — waiting for payment
        break;

      case 'payment.failed':
        await sendFCM(uid, 'Payment Failed', 'Your subscription payment failed. Please update your payment method.');
        break;

      default:
        console.log('Unhandled webhook event:', event);
    }

    return res.status(200).json({ status: 'ok', event });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
