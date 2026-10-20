import { createHash } from 'node:crypto';

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

import type { Logger } from '../logger.js';
import type { Category } from './events.js';

/** Inbox records expire after this long and are removed by the cleanup job. */
export const INBOX_LIFETIME_DAYS = 30;

export type PushMessage = {
  title: string;
  body: string;
  /** String-only data payload the app uses to route on tap. */
  data: Record<string, string>;
};

/** Abstraction over FCM so delivery logic is testable. */
export interface Messenger {
  /** Sends to [tokens]; returns the tokens FCM reported as invalid. */
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

export type Delivery = {
  type: string;
  category: Category;
  tourId: string;
  tourName: string;
  senderUid: string;
  senderName: string;
  refId?: string;
  recipients: string[];
  dedupKey: string;
  title: string;
  body: string;
};

export type DeliveryResult = { delivered: boolean; inbox: number; pushed: number };

const prefKey: Record<Category, string> = {
  important: 'important',
  expenses: 'expenses',
  plans: 'plans',
};

/**
 * Writes inbox items and sends push notifications, once per dedup key.
 * Preferences live in users/{uid}.notificationPrefs (written by the app);
 * missing prefs default to "important on, others on".
 */
export class Notifier {
  constructor(
    private readonly db: Firestore,
    private readonly messenger: Messenger,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(d: Delivery): Promise<DeliveryResult> {
    if (d.recipients.length === 0) return { delivered: false, inbox: 0, pushed: 0 };

    // Idempotency: the first request for a key wins; retries are no-ops.
    const dedupId = createHash('sha256').update(d.dedupKey).digest('hex').slice(0, 40);
    const dedupRef = this.db.doc(`serverEvents/${dedupId}`);
    const expiresAt = Timestamp.fromMillis(this.now().getTime() + INBOX_LIFETIME_DAYS * 86_400_000);
    try {
      await dedupRef.create({ type: d.type, tourId: d.tourId, createdAt: FieldValue.serverTimestamp(), expiresAt });
    } catch (e) {
      if ((e as { code?: number }).code === 6) return { delivered: false, inbox: 0, pushed: 0 }; // ALREADY_EXISTS
      throw e;
    }

    const users = await this.db.getAll(...d.recipients.map((uid) => this.db.doc(`users/${uid}`)));
    const wanted = users
      .filter((u) => {
        const prefs = (u.data()?.notificationPrefs ?? {}) as Record<string, unknown>;
        return prefs[prefKey[d.category]] !== false;
      })
      .map((u) => u.id);

    // Inbox records for everyone (the in-app list is filtered by the app);
    // important events are always recorded.
    const batch = this.db.batch();
    for (const uid of d.recipients) {
      batch.set(this.db.collection(`users/${uid}/inbox`).doc(), {
        type: d.type,
        tourId: d.tourId,
        tourName: d.tourName.slice(0, 80) || '—',
        senderUid: d.senderUid,
        senderName: d.senderName.slice(0, 60) || '—',
        ...(d.refId ? { refId: d.refId } : {}),
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        read: false,
      });
    }
    await batch.commit();

    let pushed = 0;
    if (wanted.length > 0) {
      const devices = await Promise.all(
        wanted.map((uid) => this.db.collection(`users/${uid}/devices`).limit(10).get()),
      );
      const tokenOwners = new Map<string, string>();
      devices.forEach((snap) =>
        snap.docs.forEach((doc) => {
          const token = doc.data().token;
          if (typeof token === 'string' && token) tokenOwners.set(token, doc.ref.path);
        }),
      );
      const tokens = [...tokenOwners.keys()];
      if (tokens.length > 0) {
        const { invalidTokens } = await this.messenger.send(tokens, {
          title: d.title,
          body: d.body,
          data: {
            type: d.type,
            tourId: d.tourId,
            ...(d.refId ? { refId: d.refId } : {}),
          },
        });
        pushed = tokens.length - invalidTokens.length;
        // Prune tokens FCM says are dead (uninstalled app, revoked token).
        await Promise.all(
          invalidTokens.map((t) => this.db.doc(tokenOwners.get(t)!).delete().catch(() => undefined)),
        );
      }
    }
    this.logger.info({ type: d.type, tourId: d.tourId, inbox: d.recipients.length, pushed }, 'event delivered');
    return { delivered: true, inbox: d.recipients.length, pushed };
  }
}
