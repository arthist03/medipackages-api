import type { VercelRequest, VercelResponse } from '@vercel/node';
import Razorpay from 'razorpay';
import { getDb, getAuth, setCors, safeErrorMessage } from './_shared';

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

    // Fetch invoices for this subscription
    let invoices: any[] = [];
    try {
      const invoiceList: any = await razorpay.invoices.all({
        type: 'invoice',
        subscription_id: subId,
      });
      invoices = invoiceList?.items || [];
    } catch {
      // Invoices may not exist for new/trial subscriptions
      invoices = [];
    }

    // Fetch recent payments linked to this subscription
    let payments: any[] = [];
    try {
      // Use Razorpay API to get payments for subscription
      const paymentList: any = await (razorpay as any).payments?.all({
        count: 10,
      });
      // Filter to payments related to this subscription
      if (paymentList?.items) {
        payments = paymentList.items
          .filter((p: any) => p.notes?.firebase_uid === uid || p.description?.includes(subId))
          .slice(0, 10);
      }
    } catch {
      payments = [];
    }

    return res.status(200).json({
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
