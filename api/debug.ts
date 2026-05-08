import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin, setCors } from './_shared';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let initError = null;
  let parsedProjectId = null;
  let hasPrivateKey = false;
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
  let isJsonValid = false;

  try {
    const serviceAccount = JSON.parse(raw);
    isJsonValid = true;
    parsedProjectId = serviceAccount.project_id || null;
    hasPrivateKey = !!serviceAccount.private_key;

    if (!admin.apps.length && parsedProjectId) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  } catch (e: any) {
    initError = e.message;
  }

  return res.status(200).json({
    status: 'ok',
    firebaseAdminInitialized: !!admin.apps.length,
    serviceAccountLength: raw.length,
    isJsonValid,
    parsedProjectId,
    hasPrivateKey,
    initError,
  });
}
