import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { HttpError } from './errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    uid?: string;
  }
}

/** Requires `Authorization: Bearer <Firebase ID token>`; sets `req.uid`. */
export function requireUser(verifyIdToken: (token: string) => Promise<{ uid: string }>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1]) return next(new HttpError(401, 'unauthenticated'));
    try {
      const { uid } = await verifyIdToken(match[1]);
      req.uid = uid;
      next();
    } catch {
      next(new HttpError(401, 'unauthenticated'));
    }
  };
}

/** Protects internal job endpoints with a shared secret header. */
export function requireCronSecret(secret: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const given = req.headers['x-cron-secret'];
    if (!secret || typeof given !== 'string') return next(new HttpError(401, 'unauthenticated'));
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return next(new HttpError(401, 'unauthenticated'));
    }
    next();
  };
}
