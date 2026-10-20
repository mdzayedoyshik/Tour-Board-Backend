import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import type { Logger } from '../logger.js';

/** An error with an HTTP status and a short, client-safe code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function errorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid-argument', issues: err.issues.map((i) => i.path.join('.')) });
      return;
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  };
}
