import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { HttpError } from '../middleware/errors.js';

/** Notification categories map to the user's preferences in the app. */
export type Category = 'important' | 'expenses' | 'plans';

export const eventTypes = [
  'joinRequest',
  'joinApproved',
  'joinRejected',
  'settlementSubmitted',
  'settlementConfirmed',
  'settlementDisputed',
  'tourClosed',
  'tourReopened',
  'roleChanged',
  'expenseAdded',
  'expenseEdited',
  'expenseDeleted',
  'planAdded',
  'planEdited',
] as const;

export type EventType = (typeof eventTypes)[number];

export const eventInput = z.object({
  tourId: z.string().min(1).max(128),
  type: z.enum(eventTypes),
  refId: z.string().min(1).max(128).optional(),
  subjectUid: z.string().min(1).max(128).optional(),
});

export type EventInput = z.infer<typeof eventInput>;

/** A verified event ready to be delivered. */
export type ResolvedEvent = {
  type: EventType;
  category: Category;
  tourId: string;
  tourName: string;
  actorUid: string;
  actorName: string;
  refId?: string;
  recipients: string[];
  /** Same key => same delivery; prevents duplicate notifications on retries. */
  dedupKey: string;
};

const categoryOf: Record<EventType, Category> = {
  joinRequest: 'important',
  joinApproved: 'important',
  joinRejected: 'important',
  settlementSubmitted: 'important',
  settlementConfirmed: 'important',
  settlementDisputed: 'important',
  tourClosed: 'important',
  tourReopened: 'important',
  roleChanged: 'important',
  expenseAdded: 'expenses',
  expenseEdited: 'expenses',
  expenseDeleted: 'expenses',
  planAdded: 'plans',
  planEdited: 'plans',
};

const forbidden = () => new HttpError(403, 'permission-denied');
const notFound = () => new HttpError(404, 'not-found');

function millis(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as { toMillis: () => number }).toMillis();
  }
  return 0;
}

/**
 * Verifies that [input] describes something the actor really did, using
 * the canonical Firestore documents, and returns who should be told.
 *
 * The client only *reports* an event; it cannot choose recipients or text,
 * so a member cannot spam or impersonate through this endpoint.
 */
export async function resolveEvent(
  db: Firestore,
  actorUid: string,
  input: EventInput,
): Promise<ResolvedEvent> {
  const tourRef = db.doc(`tours/${input.tourId}`);
  const tourSnap = await tourRef.get();
  if (!tourSnap.exists) throw notFound();
  const tour = tourSnap.data()!;
  const membersSnap = await tourRef.collection('members').get();
  const members = new Map(membersSnap.docs.map((d) => [d.id, d.data()]));
  const active = [...members.entries()].filter(([, m]) => m.status === 'active');
  const activeUids = active.map(([uid]) => uid);
  const managers = active.filter(([, m]) => m.role === 'host' || m.role === 'admin').map(([uid]) => uid);
  const actor = members.get(actorUid);
  const actorIsActive = actor?.status === 'active';
  const actorIsManager = actorIsActive && (actor?.role === 'host' || actor?.role === 'admin');

  let recipients: string[] = [];
  let actorName = typeof actor?.displayNameSnapshot === 'string' ? actor.displayNameSnapshot : '';
  let version = '';

  const need = <T>(value: T | undefined | null): T => {
    if (value === undefined || value === null) throw new HttpError(400, 'invalid-argument');
    return value;
  };
  const getDoc = async (path: string): Promise<DocumentData> => {
    const snap = await tourRef.collection(path.split('/')[0]!).doc(path.split('/')[1]!).get();
    if (!snap.exists) throw notFound();
    return snap.data()!;
  };

  switch (input.type) {
    case 'joinRequest': {
      // The requester is not a member yet; their pending request is the proof.
      const request = await getDoc(`joinRequests/${actorUid}`);
      if (request.status !== 'pending') throw forbidden();
      actorName = String(request.displayNameSnapshot ?? '');
      recipients = managers;
      version = `${millis(request.updatedAt)}`;
      break;
    }
    case 'joinApproved':
    case 'joinRejected': {
      if (!actorIsManager) throw forbidden();
      const subject = need(input.subjectUid);
      const request = await getDoc(`joinRequests/${subject}`);
      const expected = input.type === 'joinApproved' ? 'approved' : 'rejected';
      if (request.status !== expected || request.reviewedBy !== actorUid) throw forbidden();
      recipients = [subject];
      version = `${millis(request.reviewedAt)}`;
      break;
    }
    case 'settlementSubmitted':
    case 'settlementConfirmed':
    case 'settlementDisputed': {
      if (!actorIsActive) throw forbidden();
      const s = await getDoc(`settlements/${need(input.refId)}`);
      const counterparty = s.createdBy === s.fromUid ? s.toUid : s.fromUid;
      if (input.type === 'settlementSubmitted') {
        if (s.createdBy !== actorUid || s.status !== 'pending_confirmation') throw forbidden();
        recipients = [counterparty];
      } else if (input.type === 'settlementConfirmed') {
        if (s.status !== 'confirmed' || s.confirmedBy !== actorUid) throw forbidden();
        recipients = [s.createdBy];
      } else {
        if (s.status !== 'disputed' || counterparty !== actorUid) throw forbidden();
        recipients = [s.createdBy];
      }
      version = String(s.status);
      break;
    }
    case 'tourClosed':
    case 'tourReopened': {
      if (!actorIsManager) throw forbidden();
      const closed = tour.status === 'closed';
      if ((input.type === 'tourClosed') !== closed) throw forbidden();
      recipients = activeUids;
      version = `${millis(tour.updatedAt)}`;
      break;
    }
    case 'roleChanged': {
      if (!actorIsActive || actor?.role !== 'host') throw forbidden();
      const subject = need(input.subjectUid);
      const target = members.get(subject);
      if (target?.status !== 'active') throw forbidden();
      recipients = [subject];
      version = `${target.role}:${millis(target.updatedAt)}`;
      break;
    }
    case 'expenseAdded':
    case 'expenseEdited':
    case 'expenseDeleted': {
      if (!actorIsActive) throw forbidden();
      const e = await getDoc(`expenses/${need(input.refId)}`);
      const by = input.type === 'expenseAdded' ? e.createdBy : input.type === 'expenseDeleted' ? e.deletedBy : e.updatedBy;
      if (by !== actorUid) throw forbidden();
      if ((input.type === 'expenseDeleted') !== (e.deletedAt != null)) throw forbidden();
      recipients = activeUids;
      version = `${e.revisionCount ?? 0}`;
      break;
    }
    case 'planAdded':
    case 'planEdited': {
      if (!actorIsActive) throw forbidden();
      const p = await getDoc(`activities/${need(input.refId)}`);
      const by = input.type === 'planAdded' ? p.createdBy : p.updatedBy;
      if (by !== actorUid) throw forbidden();
      recipients = activeUids;
      version = `${millis(p.updatedAt)}`;
      break;
    }
  }

  return {
    type: input.type,
    category: categoryOf[input.type],
    tourId: input.tourId,
    tourName: String(tour.name ?? ''),
    actorUid,
    actorName: actorName || 'A member',
    refId: input.refId,
    // Never notify the actor about their own action.
    recipients: [...new Set(recipients)].filter((uid) => uid && uid !== actorUid),
    dedupKey: [input.tourId, input.type, input.refId ?? '', input.subjectUid ?? '', actorUid, version].join('|'),
  };
}
