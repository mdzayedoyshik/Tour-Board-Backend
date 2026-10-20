import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

import type { Config } from './config.js';

export type FirebaseServices = {
  app: App;
  db: Firestore;
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  messaging: ReturnType<typeof getMessaging>;
};

/**
 * Initialises Firebase Admin with the service account from config. Admin
 * access bypasses Security Rules, so every route validates authorisation
 * itself against Firestore data.
 */
export function initFirebase(config: Config): FirebaseServices {
  const app =
    getApps()[0] ??
    initializeApp(
      config.serviceAccount
        ? { credential: cert(config.serviceAccount as Parameters<typeof cert>[0]) }
        : undefined,
    );
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const auth = getAuth(app);
  return {
    app,
    db,
    verifyIdToken: async (token) => {
      // checkRevoked: tokens of deleted/disabled accounts are rejected.
      const decoded = await auth.verifyIdToken(token, true);
      return { uid: decoded.uid };
    },
    messaging: getMessaging(app),
  };
}
