import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    // Never log credentials or tokens.
    redact: ['req.headers.authorization', 'req.headers["x-cron-secret"]', '*.token', '*.tokens'],
  });
}
