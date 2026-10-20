import { FieldValue, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';

import type { Logger } from '../logger.js';
import { pushText } from './messages.js';
import type { Notifier } from './notifier.js';

const DAY = 86_400_000;

/** Retention policy (agreed with the product owner). */
export const retention = {
  /** Finished (approved/rejected/cancelled) join requests. */
  joinRequestDays: 7,
  /** Inbox items and server dedup records. */
  inboxDays: 30,
  /** Tours are deleted this long after their end date. */
  tourDays: 30,
  /** Members are warned this long before a tour is deleted. */
  warnDaysBefore: 7,
  /** Device tokens not refreshed for this long are dropped. */
  deviceDays: 60,
} as const;

export type CleanupReport = {
  invites: number;
  inbox: number;
  joinRequests: number;
  serverEvents: number;
  devices: number;
  toursDeleted: number;
  toursWarned: number;
  truncated: boolean;
};

/**
 * Daily retention job. Every query is bounded by [maxDocs] so one run can
 * never exhaust the Firestore free quota; anything left over is picked up
 * by the next day's run.
 */
export class CleanupService {
  constructor(
    private readonly db: Firestore,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly maxDocs = 2000,
  ) {}

  async run(): Promise<CleanupReport> {
    const now = this.now();
    let budget = this.maxDocs;
    const report: CleanupReport = {
      invites: 0,
      inbox: 0,
      joinRequests: 0,
      serverEvents: 0,
      devices: 0,
      toursDeleted: 0,
      toursWarned: 0,
      truncated: false,
    };
    const ago = (days: number) => Timestamp.fromMillis(now.getTime() - days * DAY);

    const drain = async (query: Query, filter: (data: FirebaseFirestore.DocumentData) => boolean = () => true) => {
      let deleted = 0;
      while (budget > 0) {
        const snap = await query.limit(Math.min(400, budget)).get();
        if (snap.empty) break;
        const victims = snap.docs.filter((d) => filter(d.data()));
        budget -= snap.size;
        if (victims.length > 0) {
          const batch = this.db.batch();
          victims.forEach((d) => batch.delete(d.ref));
          await batch.commit();
          deleted += victims.length;
        }
        // A page with nothing deletable means the rest is also kept.
        if (victims.length === 0 || snap.size < 400) break;
      }
      return deleted;
    };

    // Expired or revoked join codes.
    report.invites += await drain(this.db.collection('invites').where('expiresAt', '<', Timestamp.fromDate(now)));
    report.invites += await drain(this.db.collection('invites').where('revoked', '==', true));

    // Inbox items past their expiry (30 days).
    report.inbox = await drain(this.db.collectionGroup('inbox').where('expiresAt', '<', Timestamp.fromDate(now)));

    // Finished join requests older than 7 days. Pending ones are kept.
    report.joinRequests = await drain(
      this.db.collectionGroup('joinRequests').where('updatedAt', '<', ago(retention.joinRequestDays)),
      (d) => d.status !== 'pending',
    );

    report.serverEvents = await drain(
      this.db.collection('serverEvents').where('expiresAt', '<', Timestamp.fromDate(now)),
    );
    report.devices = await drain(
      this.db.collectionGroup('devices').where('updatedAt', '<', ago(retention.deviceDays)),
    );

    // Warn members a week before deletion (once per tour).
    const warnCutoff = ago(retention.tourDays - retention.warnDaysBefore);
    const toWarn = await this.db
      .collection('tours')
      .where('endAt', '<', warnCutoff)
      .orderBy('endAt')
      .limit(50)
      .get();
    for (const tour of toWarn.docs) {
      if (tour.data().deletionWarningSentAt) continue;
      const deleteOn = new Date(tour.data().endAt.toMillis() + retention.tourDays * DAY);
      if (deleteOn <= now) continue; // Deleted below instead.
      const members = await tour.ref.collection('members').where('status', '==', 'active').get();
      const name = String(tour.data().name ?? '');
      const date = deleteOn.toISOString().slice(0, 10);
      await this.notifier.deliver({
        type: 'tourDeletionSoon',
        category: 'important',
        tourId: tour.id,
        tourName: name,
        senderUid: 'system',
        senderName: 'Tour Board',
        recipients: members.docs.map((m) => m.id),
        dedupKey: `deletion-warning|${tour.id}`,
        ...pushText('tourDeletionSoon', { actor: '', tour: name, date }),
      });
      await tour.ref.update({ deletionWarningSentAt: FieldValue.serverTimestamp() });
      report.toursWarned++;
    }

    // Delete tours 30 days after their end date, with every subcollection.
    const expired = await this.db
      .collection('tours')
      .where('endAt', '<', ago(retention.tourDays))
      .limit(10)
      .get();
    for (const tour of expired.docs) {
      if (budget <= 0) break;
      await this.deleteTour(tour.id);
      report.toursDeleted++;
      budget -= 50; // Rough cost accounting per tour.
    }

    report.truncated = budget <= 0;
    this.logger.info({ report }, 'cleanup finished');
    return report;
  }

  /**
   * Fully deletes a tour: all subcollections (recursively), every member's
   * Home index entry and the current join code.
   */
  async deleteTour(tourId: string): Promise<void> {
    const ref = this.db.doc(`tours/${tourId}`);
    const snap = await ref.get();
    if (!snap.exists) return;
    const members = await ref.collection('members').get();
    const batch = this.db.batch();
    for (const m of members.docs) {
      batch.delete(this.db.doc(`users/${m.id}/tourMemberships/${tourId}`));
    }
    const code = snap.data()?.inviteCode;
    if (typeof code === 'string' && code) batch.delete(this.db.doc(`invites/${code}`));
    await batch.commit();
    await this.db.recursiveDelete(ref);
    this.logger.info({ tourId }, 'tour deleted');
  }
}
