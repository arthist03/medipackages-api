import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import { admin, getDb, getAuth, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid } = req.body || {};
  if (!uid || typeof uid !== 'string') {
    return res.status(400).json({ error: 'Missing uid' });
  }

  // Verify user
  try { await getAuth().getUser(uid); } catch { return res.status(403).json({ error: 'Invalid user' }); }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return res.status(500).json({ error: 'Payment service misconfigured' });

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  try {
    // Get user's subscription ID from Firestore
    const userDoc = await getDb().collection('users').doc(uid).get();
    const userData = userDoc.data();
    const subId = userData?.subscription?.razorpaySubscriptionId;

    if (!subId) {
      return res.status(200).json({ subscription: null, invoices: [] });
    }

    // Fetch subscription details from Razorpay
    const subscription: any = await razorpay.subscriptions.fetch(subId);
    const rzpStatus: string = subscription.status || '';

    // ── Self-healing sync ─────────────────────────────────────────────
    // If Razorpay shows authenticated/active but Firestore doesn't
    // reflect it (webhook may have failed), fix it now.
    const firestorePlan = userData?.subscription?.plan || 'free';
    const firestoreStatus = userData?.subscription?.status || 'none';
    const needsSync =
      (rzpStatus === 'authenticated' && firestorePlan !== 'trial' && firestoreStatus !== 'trialing') ||
      (rzpStatus === 'active' && firestorePlan !== 'pro');

    if (needsSync) {
      console.log(`[Self-heal] Syncing subscription for ${uid}: Razorpay=${rzpStatus}, Firestore=${firestorePlan}/${firestoreStatus}`);

      if (rzpStatus === 'authenticated') {
        // Trial — user verified payment but first charge hasn't happened
        const trialEnd = new Date();
        trialEnd.setDate(trialEnd.getDate() + 2);
        await getDb().collection('users').doc(uid).update({
          'subscription.plan': 'trial',
          'subscription.status': 'trialing',
          'subscription.razorpaySubscriptionId': subscription.id,
          'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
          'subscription.trialEndDate': admin.firestore.Timestamp.fromDate(trialEnd),
          'subscription.endDate': admin.firestore.Timestamp.fromDate(trialEnd),
          'subscription.grantedBy': 'trial',
          'aiEnabled': true,
          'aiLimit': 50000,
        });
      } else if (rzpStatus === 'active') {
        // Pro — subscription is active and charging
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30);
        await getDb().collection('users').doc(uid).update({
          'subscription.plan': 'pro',
          'subscription.status': 'active',
          'subscription.razorpaySubscriptionId': subscription.id,
          'subscription.lastPaymentAt': admin.firestore.FieldValue.serverTimestamp(),
          'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
          'subscription.grantedBy': 'payment',
          'aiEnabled': true,
          'aiLimit': 50000,
        });
      }
    }

    // Fetch invoices for this subscription
    let invoices: any[] = [];
    try {
      const invoiceList: any = await razorpay.invoices.all({
        type: 'invoice',
        subscription_id: subId,
      });
      invoices = invoiceList?.items || [];
    } catch {
      invoices = [];
    }

    return res.status(200).json({
      synced: needsSync,
      subscription: {
        id: subscription.id,
        planId: subscription.plan_id,
        status: subscription.status,
        currentStart: subscription.current_start ? new Date(subscription.current_start * 1000).toISOString() : null,
        currentEnd: subscription.current_end ? new Date(subscription.current_end * 1000).toISOString() : null,
        chargeAt: subscription.charge_at ? new Date(subscription.charge_at * 1000).toISOString() : null,
        startAt: subscription.start_at ? new Date(subscription.start_at * 1000).toISOString() : null,
        endAt: subscription.end_at ? new Date(subscription.end_at * 1000).toISOString() : null,
        totalCount: subscription.total_count,
        paidCount: subscription.paid_count,
        remainingCount: subscription.remaining_count,
        shortUrl: subscription.short_url,
        createdAt: subscription.created_at ? new Date(subscription.created_at * 1000).toISOString() : null,
        amount: subscription.plan?.item?.amount ? subscription.plan.item.amount / 100 : 99,
        currency: subscription.plan?.item?.currency || 'INR',
      },
      invoices: invoices.map((inv: any) => ({
        id: inv.id,
        amount: inv.amount ? inv.amount / 100 : 0,
        currency: inv.currency || 'INR',
        status: inv.status,
        date: inv.date ? new Date(inv.date * 1000).toISOString() : null,
        paidAt: inv.paid_at ? new Date(inv.paid_at * 1000).toISOString() : null,
        shortUrl: inv.short_url,
      })),
    });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
