import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import type { Logger } from './logger.js';
import { requireCronSecret, requireUser } from './middleware/auth.js';
import { errorHandler, HttpError } from './middleware/errors.js';
import type { CleanupService } from './services/cleanup.js';
import { eventInput, resolveEvent } from './services/events.js';
import { pushText } from './services/messages.js';
import type { Notifier } from './services/notifier.js';
import type { PlacesClient } from './services/places.js';

export type AppDeps = {
  db: Firestore;
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  notifier: Notifier;
  places: PlacesClient;
  cleanup: CleanupService;
  cronSecret?: string;
  logger: Logger;
  version: string;
};

type Handler = (req: Request, res: Response) => Promise<void>;

/** Wraps async handlers so rejections reach the error middleware. */
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

/** Per-user limiter (keyed by Firebase uid, after authentication). */
const perUser = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.uid ?? 'anonymous',
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate-limited' });
    },
  });

const coord = (min: number, max: number) => z.coerce.number().min(min).max(max);
const lang = z.string().regex(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})?$/).optional();
const session = z.string().max(64).optional();

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of the app.
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, version: deps.version });
  });

  const user = requireUser(deps.verifyIdToken);

  // The app reports something it just did; the server verifies it and
  // notifies the right people (inbox + push).
  app.post(
    '/v1/events',
    user,
    perUser(60_000, 60),
    route(async (req, res) => {
      const input = eventInput.parse(req.body);
      const event = await resolveEvent(deps.db, req.uid!, input);
      const result = await deps.notifier.deliver({
        type: event.type,
        category: event.category,
        tourId: event.tourId,
        tourName: event.tourName,
        senderUid: event.actorUid,
        senderName: event.actorName,
        refId: event.refId,
        recipients: event.recipients,
        dedupKey: event.dedupKey,
        ...pushText(event.type, { actor: event.actorName, tour: event.tourName }),
      });
      res.json({ delivered: result.delivered, recipients: result.inbox });
    }),
  );

  // Place search proxy: the Google key stays on the server. Tight per-user
  // limits protect the monthly free tier.
  const placesLimit = [perUser(60_000, 30), perUser(24 * 60 * 60_000, 300)];

  app.get(
    '/v1/places/autocomplete',
    user,
    ...placesLimit,
    route(async (req, res) => {
      const q = z
        .object({
          q: z.string().trim().min(2).max(120),
          lang,
          session,
          lat: coord(-90, 90).optional(),
          lng: coord(-180, 180).optional(),
        })
        .parse(req.query);
      const suggestions = await deps.places.autocomplete({
        query: q.q,
        language: q.lang,
        session: q.session,
        lat: q.lat,
        lng: q.lng,
      });
      res.json({ suggestions });
    }),
  );

  app.get(
    '/v1/places/details/:placeId',
    user,
    ...placesLimit,
    route(async (req, res) => {
      const placeId = z.string().min(1).max(300).parse(req.params.placeId);
      const q = z.object({ lang, session }).parse(req.query);
      res.json({ place: await deps.places.details(placeId, { language: q.lang, session: q.session }) });
    }),
  );

  app.get(
    '/v1/places/reverse',
    user,
    ...placesLimit,
    route(async (req, res) => {
      const q = z.object({ lat: coord(-90, 90), lng: coord(-180, 180), lang }).parse(req.query);
      res.json({ place: await deps.places.reverseGeocode(q.lat, q.lng, q.lang) });
    }),
  );

  // Host deletes an archived tour; the server can delete recursively.
  app.delete(
    '/v1/tours/:tourId',
    user,
    perUser(60_000, 5),
    route(async (req, res) => {
      const tourId = z.string().min(1).max(128).parse(req.params.tourId);
      const tour = await deps.db.doc(`tours/${tourId}`).get();
      if (!tour.exists) throw new HttpError(404, 'not-found');
      const me = await deps.db.doc(`tours/${tourId}/members/${req.uid}`).get();
      if (me.data()?.status !== 'active' || me.data()?.role !== 'host') {
        throw new HttpError(403, 'permission-denied');
      }
      if (tour.data()?.status !== 'archived') throw new HttpError(409, 'failed-precondition');
      await deps.cleanup.deleteTour(tourId);
      res.json({ deleted: true });
    }),
  );

  // Daily retention job, triggered by a scheduled GitHub Action.
  app.post(
    '/internal/jobs/cleanup',
    requireCronSecret(deps.cronSecret),
    route(async (_req, res) => {
      res.json(await deps.cleanup.run());
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not-found' });
  });
  app.use(errorHandler(deps.logger));
  return app;
}
