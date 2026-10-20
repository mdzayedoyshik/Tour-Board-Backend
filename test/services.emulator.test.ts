import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CleanupService } from '../src/services/cleanup.js';
import { resolveEvent } from '../src/services/events.js';
import { Notifier, type Messenger, type PushMessage } from '../src/services/notifier.js';
import { UsageGuard } from '../src/services/usage.js';

const PROJECT = 'demo-tour-board';
const DAY = 86_400_000;
const logger = pino({ level: 'silent' });
let db: Firestore;

class FakeMessenger implements Messenger {
  sent: Array<{ tokens: string[]; message: PushMessage }> = [];
  invalid = new Set<string>();
  async send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return { invalidTokens: tokens.filter((t) => this.invalid.has(t)) };
  }
}

const ts = (ms: number) => Timestamp.fromMillis(ms);

async function clear() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
}

async function seedTour(overrides: Record<string, unknown> = {}) {
  await db.doc('tours/t1').set({ name: 'Trip', status: 'active', endAt: ts(Date.now() + DAY), inviteCode: 'CODE00000000', ...overrides });
  const member = (role: string, status = 'active') => ({ role, status, displayNameSnapshot: 'x' });
  await db.doc('tours/t1/members/host').set({ ...member('host'), displayNameSnapshot: 'Hana' });
  await db.doc('tours/t1/members/alice').set({ ...member('member'), displayNameSnapshot: 'Alice' });
  await db.doc('tours/t1/members/bob').set({ ...member('member'), displayNameSnapshot: 'Bob' });
  await db.doc('tours/t1/members/gone').set(member('member', 'removed'));
  for (const uid of ['host', 'alice', 'bob']) {
    await db.doc(`users/${uid}/devices/d1`).set({ token: `tok-${uid}`, updatedAt: ts(Date.now()) });
    await db.doc(`users/${uid}/tourMemberships/t1`).set({ tourId: 't1' });
  }
}

beforeAll(() => {
  const app = getApps()[0] ?? initializeApp({ projectId: PROJECT });
  db = getFirestore(app);
});

beforeEach(clear);

describe('resolveEvent', () => {
  beforeEach(() => seedTour());

  it('notifies managers of a pending join request', async () => {
    await db.doc('tours/t1/joinRequests/carol').set({ status: 'pending', displayNameSnapshot: 'Carol', updatedAt: ts(1) });
    const e = await resolveEvent(db, 'carol', { tourId: 't1', type: 'joinRequest' });
    expect(e.recipients).toEqual(['host']);
    expect(e.actorName).toBe('Carol');
  });

  it('rejects events the actor did not perform', async () => {
    await db.doc('tours/t1/settlements/s1').set({
      fromUid: 'bob', toUid: 'alice', createdBy: 'bob', status: 'pending_confirmation',
    });
    await expect(
      resolveEvent(db, 'alice', { tourId: 't1', type: 'settlementSubmitted', refId: 's1' }),
    ).rejects.toMatchObject({ status: 403 });
    const ok = await resolveEvent(db, 'bob', { tourId: 't1', type: 'settlementSubmitted', refId: 's1' });
    expect(ok.recipients).toEqual(['alice']);
  });

  it('non-members and removed members cannot report events', async () => {
    await db.doc('tours/t1/expenses/e1').set({ createdBy: 'gone', revisionCount: 0 });
    await expect(
      resolveEvent(db, 'gone', { tourId: 't1', type: 'expenseAdded', refId: 'e1' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resolveEvent(db, 'stranger', { tourId: 't1', type: 'tourClosed' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('expense updates go to every other active member', async () => {
    await db.doc('tours/t1/expenses/e1').set({ createdBy: 'alice', revisionCount: 0 });
    const e = await resolveEvent(db, 'alice', { tourId: 't1', type: 'expenseAdded', refId: 'e1' });
    expect(e.recipients.sort()).toEqual(['bob', 'host']);
    expect(e.category).toBe('expenses');
  });

  it('tour status events must match the stored status', async () => {
    await expect(resolveEvent(db, 'host', { tourId: 't1', type: 'tourClosed' })).rejects.toMatchObject({ status: 403 });
    await db.doc('tours/t1').update({ status: 'closed' });
    const e = await resolveEvent(db, 'host', { tourId: 't1', type: 'tourClosed' });
    expect(e.recipients.sort()).toEqual(['alice', 'bob']);
  });
});

describe('Notifier', () => {
  beforeEach(() => seedTour());

  const delivery = (recipients: string[], category: 'important' | 'expenses' = 'important') => ({
    type: 'expenseAdded',
    category,
    tourId: 't1',
    tourName: 'Trip',
    senderUid: 'alice',
    senderName: 'Alice',
    refId: 'e1',
    recipients,
    dedupKey: `k|${recipients.join(',')}|${category}`,
    title: 'Trip',
    body: 'Alice added an expense',
  });

  it('writes inbox items, pushes once and is idempotent', async () => {
    const fcm = new FakeMessenger();
    const notifier = new Notifier(db, fcm, logger);
    const first = await notifier.deliver(delivery(['bob', 'host']));
    const again = await notifier.deliver(delivery(['bob', 'host']));
    expect(first).toMatchObject({ delivered: true, inbox: 2, pushed: 2 });
    expect(again.delivered).toBe(false);
    expect((await db.collection('users/bob/inbox').get()).size).toBe(1);
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]!.message.data).toMatchObject({ tourId: 't1', type: 'expenseAdded' });
  });

  it('honours preferences for push but still records the inbox item', async () => {
    await db.doc('users/bob').set({ notificationPrefs: { expenses: false } });
    const fcm = new FakeMessenger();
    await new Notifier(db, fcm, logger).deliver(delivery(['bob'], 'expenses'));
    expect(fcm.sent).toHaveLength(0);
    expect((await db.collection('users/bob/inbox').get()).size).toBe(1);
  });

  it('prunes tokens FCM reports as invalid', async () => {
    const fcm = new FakeMessenger();
    fcm.invalid.add('tok-bob');
    await new Notifier(db, fcm, logger).deliver(delivery(['bob']));
    expect((await db.doc('users/bob/devices/d1').get()).exists).toBe(false);
  });
});

describe('CleanupService', () => {
  it('applies the retention policy', async () => {
    const now = Date.now();
    await seedTour({ endAt: ts(now - 31 * DAY) });
    await db.doc('tours/t1/expenses/e1').set({ title: 'old' });
    await db.doc('invites/CODE00000000').set({ tourId: 't1', expiresAt: ts(now + DAY), revoked: false });
    await db.doc('invites/EXPIRED00000').set({ tourId: 'x', expiresAt: ts(now - DAY), revoked: false });
    await db.doc('invites/FRESH0000000').set({ tourId: 'y', expiresAt: ts(now + DAY), revoked: false });
    await db.doc('users/bob/inbox/old').set({ expiresAt: ts(now - 1) });
    await db.doc('users/bob/inbox/new').set({ expiresAt: ts(now + DAY) });
    await db.doc('tours/t2').set({ name: 'Live', endAt: ts(now + 10 * DAY) });
    await db.doc('tours/t2/joinRequests/a').set({ status: 'rejected', updatedAt: ts(now - 8 * DAY) });
    await db.doc('tours/t2/joinRequests/b').set({ status: 'pending', updatedAt: ts(now - 8 * DAY) });
    await db.doc('tours/t2/joinRequests/c').set({ status: 'cancelled', updatedAt: ts(now - 2 * DAY) });

    const report = await new CleanupService(db, new Notifier(db, new FakeMessenger(), logger), logger).run();

    expect(report.toursDeleted).toBe(1);
    expect((await db.doc('tours/t1').get()).exists).toBe(false);
    expect((await db.doc('tours/t1/expenses/e1').get()).exists).toBe(false);
    expect((await db.doc('users/alice/tourMemberships/t1').get()).exists).toBe(false);
    expect((await db.doc('invites/CODE00000000').get()).exists).toBe(false);
    expect((await db.doc('invites/EXPIRED00000').get()).exists).toBe(false);
    expect((await db.doc('invites/FRESH0000000').get()).exists).toBe(true);
    expect((await db.doc('users/bob/inbox/old').get()).exists).toBe(false);
    expect((await db.doc('users/bob/inbox/new').get()).exists).toBe(true);
    expect((await db.doc('tours/t2/joinRequests/a').get()).exists).toBe(false);
    expect((await db.doc('tours/t2/joinRequests/b').get()).exists).toBe(true);
    expect((await db.doc('tours/t2/joinRequests/c').get()).exists).toBe(true);
    expect((await db.doc('tours/t2').get()).exists).toBe(true);
  });

  it('warns members once, a week before deletion', async () => {
    const now = Date.now();
    await seedTour({ endAt: ts(now - 25 * DAY) });
    const fcm = new FakeMessenger();
    const cleanup = new CleanupService(db, new Notifier(db, fcm, logger), logger);
    expect((await cleanup.run()).toursWarned).toBe(1);
    expect((await cleanup.run()).toursWarned).toBe(0);
    expect(fcm.sent).toHaveLength(1);
    expect(fcm.sent[0]!.message.body).toContain('will be deleted');
    expect((await db.doc('tours/t1').get()).data()?.deletionWarningSentAt).toBeTruthy();
    expect((await db.collection('users/alice/inbox').get()).docs[0]!.data().type).toBe('tourDeletionSoon');
  });
});

describe('UsageGuard', () => {
  it('enforces monthly caps across instances', async () => {
    const caps = { autocomplete: 2, placeDetails: 1, geocoding: 1 };
    const a = new UsageGuard(db, caps);
    expect(await a.tryConsume('autocomplete')).toBe(true);
    expect(await a.tryConsume('autocomplete')).toBe(true);
    expect(await a.tryConsume('autocomplete')).toBe(false);
    const b = new UsageGuard(db, caps);
    expect(await b.tryConsume('autocomplete')).toBe(false);
    expect(await b.tryConsume('geocoding')).toBe(true);
  });
});
