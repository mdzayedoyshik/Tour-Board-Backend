import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
});

export type Config = {
  port: number;
  env: 'development' | 'production' | 'test';
  logLevel: string;
  /** Parsed service-account JSON, or undefined to use application-default credentials. */
  serviceAccount?: Record<string, unknown>;
  mapsServerKey?: string;
  cronSecret?: string;
};

/** Accepts raw JSON or base64-encoded JSON (convenient for env vars). */
export function parseServiceAccount(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.project_id !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not a service-account JSON');
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    port: parsed.PORT,
    env: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    serviceAccount: parseServiceAccount(parsed.FIREBASE_SERVICE_ACCOUNT),
    mapsServerKey: parsed.GOOGLE_MAPS_SERVER_KEY || undefined,
    cronSecret: parsed.CRON_SECRET || undefined,
  };
}
