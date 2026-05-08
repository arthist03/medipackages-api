/**
 * Shared utilities for all API handlers.
 * - Firebase Admin singleton
 * - CORS helper
 * - Firestore accessor
 */
import type { VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';

// ── Firebase Admin Singleton ──────────────────────────────────────────
// Each Vercel serverless function may share the same process across
// warm invocations. Initialize once and reuse.
if (!admin.apps.length) {
  try {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
    // Vercel sometimes escapes the newlines in the private key string or double-escapes them.
    // Try to normalize it so JSON.parse succeeds.
    raw = raw.trim();
    if (!raw.startsWith('{') && raw.startsWith('"{')) {
      raw = JSON.parse(raw); // Un-stringify if it was wrapped in quotes
    }

    const serviceAccount = JSON.parse(raw);
    
    // Ensure private_key has proper newlines, not escaped string literals
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    if (serviceAccount.project_id) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('Firebase Admin initialized successfully.');
    } else {
      console.error('FIREBASE_SERVICE_ACCOUNT is empty or malformed — project_id is missing.');
    }
  } catch (e: any) {
    console.error('Firebase Admin init failed. Please check Vercel FIREBASE_SERVICE_ACCOUNT formatting:', e.message);
  }
}

/** Firestore accessor — safe to call even if Firebase isn't initialised. */
export function getDb() {
  if (!admin.apps.length) throw new Error('Firebase Admin not initialised');
  return admin.firestore();
}

/** Firebase Auth accessor */
export function getAuth() {
  if (!admin.apps.length) throw new Error('Firebase Admin not initialised');
  return admin.auth();
}

/** Firebase Messaging accessor */
export function getMessaging() {
  if (!admin.apps.length) throw new Error('Firebase Admin not initialised');
  return admin.messaging();
}

/** Re-export admin for Timestamp, FieldValue, etc. */
export { admin };

// ── CORS Helper ───────────────────────────────────────────────────────
const ALLOWED_HEADERS = 'Content-Type, Authorization, x-razorpay-signature';

export function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
}

// ── Safe Error Message ────────────────────────────────────────────────
// Never expose raw error.message to the client in production.
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Only log full message server-side
    console.error('[API Error]', error.message);
  }
  return 'An unexpected error occurred. Please try again.';
}

// ── FCM Push Notification ─────────────────────────────────────────────
export async function sendFCM(uid: string, title: string, body: string) {
  try {
    const userDoc = await getDb().collection('users').doc(uid).get();
    const fcmToken = userDoc.data()?.fcmToken;
    if (!fcmToken) return; // No token — user hasn't enabled push

    await getMessaging().send({
      token: fcmToken,
      notification: { title, body },
      data: { type: 'subscription_update' },
      android: { notification: { icon: 'not_icon', color: '#0052D4' } },
    });
  } catch (e) {
    // FCM failures are non-critical — log and continue
    console.error('FCM send error:', e);
  }
}
