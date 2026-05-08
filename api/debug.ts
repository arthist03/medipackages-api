import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin, setCors, safeErrorMessage } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
    const isFirebaseConfigured = !!admin.apps.length;
    
    return res.status(200).json({
      status: 'ok',
      firebaseAdminInitialized: isFirebaseConfigured,
      serviceAccountLength: raw.length,
      razorpayKeyId: !!process.env.RAZORPAY_KEY_ID,
      razorpayKeySecret: !!process.env.RAZORPAY_KEY_SECRET,
      razorpayPlanId: !!process.env.RAZORPAY_PLAN_ID,
    });
  } catch (error) {
    return res.status(500).json({ error: safeErrorMessage(error) });
  }
}
