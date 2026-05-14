import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { admin, getDb, setCors, sendFCM } from './_shared';

// ── Signature Verification ────────────────────────────────────────────
function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Subscription Lifecycle Handlers ───────────────────────────────────

async function grantTrial(uid: string, subscriptionId: string) {
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 2); // 2-day trial

  await getDb().collection('users').doc(uid).update({
    'subscription.plan': 'trial',
    'subscription.status': 'trialing',
    'subscription.razorpaySubscriptionId': subscriptionId,
    'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.trialEndDate': admin.firestore.Timestamp.fromDate(trialEnd),
    'subscription.endDate': admin.firestore.Timestamp.fromDate(trialEnd),
    'subscription.grantedBy': 'trial',
    'aiEnabled': true,
    'aiLimit': 50000,
  });

  await getDb().collection('subscriptions').add({
    uid,
    event: 'trial_started',
    plan: 'trial',
    razorpaySubscriptionId: subscriptionId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(trialEnd),
  });

  await sendFCM(uid, '🎉 Trial Started!', 'Your 2-day free trial is active. Enjoy all premium features!');
}

async function grantPro(uid: string, subscriptionId: string, paymentId?: string) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);

  await getDb().collection('users').doc(uid).update({
    'subscription.plan': 'pro',
    'subscription.status': 'active',
    'subscription.razorpaySubscriptionId': subscriptionId,
    'subscription.lastPaymentAt': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
    'subscription.grantedBy': 'payment',
    'aiEnabled': true,
    'aiLimit': 50000,
  });

  await getDb().collection('subscriptions').add({
    uid,
    event: 'activated',
    plan: 'pro',
    amount: 9900,
    currency: 'INR',
    razorpaySubscriptionId: subscriptionId,
    razorpayPaymentId: paymentId ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(endDate),
  });

  await sendFCM(uid, '🎉 Subscription Active', "You're all set! Your subscription is active and premium features are unlocked.");
}

async function renewPro(uid: string, paymentId: string) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);

  await getDb().collection('users').doc(uid).update({
    'subscription.plan': 'pro',
    'subscription.status': 'active',
    'subscription.lastPaymentAt': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
    'aiLimit': 50000,
  });

  await getDb().collection('subscriptions').add({
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
  await getDb().collection('users').doc(uid).update({
    'subscription.plan': 'free',
    'subscription.status': 'expired',
    'aiLimit': 10000,
    'aiEnabled': false,
  });

  await getDb().collection('subscriptions').add({
    uid,
    event: 'expired',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendFCM(uid, 'Subscription Expired', 'Your subscription has expired. Premium features are now locked.');
}

async function markCancelled(uid: string) {
  await getDb().collection('users').doc(uid).update({
    'subscription.status': 'cancelled',
    'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendFCM(uid, 'Subscription Cancelled', 'Your subscription has been cancelled. You will retain access until the current period ends.');
}

// ── Main Handler ──────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify Razorpay webhook signature ───────────────────────────────
  const signature = req.headers['x-razorpay-signature'] as string;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or secret' });
  }

  // Vercel auto-parses JSON bodies — we need the raw string for HMAC
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.error('Webhook signature mismatch');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // ── Extract event and payload ───────────────────────────────────────
  const event: string = req.body?.event;
  const payload = req.body?.payload;

  if (!event || !payload) {
    return res.status(400).json({ error: 'Malformed webhook payload' });
  }

  const subscriptionEntity = payload.subscription?.entity;
  const paymentEntity = payload.payment?.entity;
  const notes = subscriptionEntity?.notes || paymentEntity?.notes || {};
  const uid: string | undefined = notes.firebase_uid;

  if (!uid) {
    // Razorpay may send webhooks for non-app subscriptions — acknowledge and skip
    console.warn('No firebase_uid in webhook notes:', JSON.stringify(notes));
    return res.status(200).json({ status: 'ok', message: 'No UID — skipped' });
  }

  // ── Verify user doc exists before mutating ──────────────────────────
  try {
    const userDoc = await getDb().collection('users').doc(uid).get();
    if (!userDoc.exists) {
      console.error(`Webhook for non-existent user: ${uid}`);
      return res.status(200).json({ status: 'ok', message: 'User not found — skipped' });
    }
  } catch (e) {
    console.error('Error verifying user doc:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── Process event ───────────────────────────────────────────────────
  try {
    switch (event) {
      case 'subscription.authenticated':
        // User verified payment method — grant trial access immediately
        await grantTrial(uid, subscriptionEntity?.id);
        break;

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
        // Waiting for payment — no action needed
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
    // Always return 200 to Razorpay to prevent retries on non-retryable errors
    return res.status(200).json({ status: 'error', message: 'Processing failed but acknowledged' });
  }
}
