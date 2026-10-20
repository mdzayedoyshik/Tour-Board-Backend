import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp, type AppDeps } from '../src/app.js';
import { parseServiceAccount } from '../src/config.js';
import { pushText } from '../src/services/messages.js';
import { PlacesClient } from '../src/services/places.js';

const logger = pino({ level: 'silent' });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('config', () => {
  const sa = { project_id: 'p', private_key: 'k', client_email: 'e' };

  it('parses raw and base64 service accounts', () => {
    expect(parseServiceAccount(JSON.stringify(sa))).toMatchObject({ project_id: 'p' });
    expect(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64'))).toMatchObject({
      project_id: 'p',
    });
    expect(parseServiceAccount('')).toBeUndefined();
  });

  it('rejects JSON that is not a service account', () => {
    expect(() => parseServiceAccount('{"a":1}')).toThrow();
  });
});

describe('PlacesClient', () => {
  it('maps autocomplete suggestions and caches repeated queries', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        suggestions: [
          {
            placePrediction: {
              placeId: 'p1',
              structuredFormat: { mainText: { text: 'Inani Beach' }, secondaryText: { text: 'Cox’s Bazar' } },
            },
          },
          { queryPrediction: { text: { text: 'ignored' } } },
        ],
      }),
    );
    const client = new PlacesClient('key', undefined, fetchImpl as unknown as typeof fetch);
    const first = await client.autocomplete({ query: 'inani', session: 's1' });
    const second = await client.autocomplete({ query: 'INANI', session: 's1' });
    expect(first).toEqual([{ placeId: 'p1', primary: 'Inani Beach', secondary: 'Cox’s Bazar' }]);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requests only Essentials fields for details', async () => {
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
      const mask = (init.headers as Record<string, string>)['X-Goog-FieldMask'];
      expect(mask).not.toContain('displayName');
      return jsonResponse({
        id: 'p1',
        shortFormattedAddress: 'Inani Beach, Ukhia',
        formattedAddress: 'Inani Beach, Ukhia, Bangladesh',
        location: { latitude: 21.2, longitude: 92.05 },
      });
    });
    const client = new PlacesClient('key', undefined, fetchImpl as unknown as typeof fetch);
    const place = await client.details('p1');
    expect(place).toEqual({
      placeId: 'p1',
      name: 'Inani Beach',
      address: 'Inani Beach, Ukhia, Bangladesh',
      lat: 21.2,
      lng: 92.05,
    });
  });

  it('reverse geocodes to a short name and address', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: 'OK',
        results: [
          {
            formatted_address: 'Marine Drive, Cox’s Bazar, Bangladesh',
            address_components: [{ long_name: 'Marine Drive', types: ['route'] }],
          },
        ],
      }),
    );
    const client = new PlacesClient('key', undefined, fetchImpl as unknown as typeof fetch);
    expect(await client.reverseGeocode(21.4, 92.0)).toMatchObject({ name: 'Marine Drive', lat: 21.4 });
  });

  it('maps upstream errors and missing keys to safe errors', async () => {
    const limited = new PlacesClient('key', undefined, (async () => jsonResponse({}, 429)) as unknown as typeof fetch);
    await expect(limited.autocomplete({ query: 'abc' })).rejects.toMatchObject({ status: 429 });
    const noKey = new PlacesClient(undefined);
    await expect(noKey.autocomplete({ query: 'abc' })).rejects.toMatchObject({ status: 503 });
  });

  it('stops when the monthly free-tier cap is reached', async () => {
    const usage = { tryConsume: vi.fn(async () => false) };
    const fetchImpl = vi.fn();
    const client = new PlacesClient('key', usage as never, fetchImpl as unknown as typeof fetch);
    await expect(client.autocomplete({ query: 'abc' })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('pushText', () => {
  it('names the actor and tour without exposing details', () => {
    expect(pushText('settlementSubmitted', { actor: 'Bob', tour: 'Trip' })).toEqual({
      title: 'Trip',
      body: 'Bob recorded a payment for you to confirm',
    });
    expect(pushText('tourDeletionSoon', { actor: '', tour: 'Trip', date: '2026-11-20' }).body).toContain('2026-11-20');
  });
});

describe('HTTP', () => {
  const deps = (overrides: Partial<AppDeps> = {}): AppDeps => ({
    db: {} as never,
    verifyIdToken: async (t) => {
      if (t !== 'good') throw new Error('bad');
      return { uid: 'alice' };
    },
    notifier: {} as never,
    places: new PlacesClient(
      'key',
      undefined,
      (async () => jsonResponse({ suggestions: [] })) as unknown as typeof fetch,
    ),
    cleanup: { run: async () => ({ invites: 1 }) } as never,
    cronSecret: 'a-very-long-cron-secret',
    logger,
    version: 'test',
    ...overrides,
  });

  it('serves health without auth', async () => {
    const res = await request(createApp(deps())).get('/health');
    expect(res.body).toEqual({ ok: true, version: 'test' });
  });

  it('requires a valid ID token', async () => {
    const app = createApp(deps());
    expect((await request(app).get('/v1/places/autocomplete?q=abc')).status).toBe(401);
    expect(
      (await request(app).get('/v1/places/autocomplete?q=abc').set('Authorization', 'Bearer nope')).status,
    ).toBe(401);
    const ok = await request(app).get('/v1/places/autocomplete?q=abc').set('Authorization', 'Bearer good');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ suggestions: [] });
  });

  it('validates input', async () => {
    const app = createApp(deps());
    const res = await request(app).get('/v1/places/reverse?lat=200&lng=0').set('Authorization', 'Bearer good');
    expect(res.status).toBe(400);
    const ev = await request(app).post('/v1/events').set('Authorization', 'Bearer good').send({ type: 'hack' });
    expect(ev.status).toBe(400);
  });

  it('protects the cleanup job with the cron secret', async () => {
    const app = createApp(deps());
    expect((await request(app).post('/internal/jobs/cleanup')).status).toBe(401);
    expect((await request(app).post('/internal/jobs/cleanup').set('X-Cron-Secret', 'wrong')).status).toBe(401);
    const ok = await request(app).post('/internal/jobs/cleanup').set('X-Cron-Secret', 'a-very-long-cron-secret');
    expect(ok.body).toEqual({ invites: 1 });
    const disabled = createApp(deps({ cronSecret: undefined }));
    expect((await request(disabled).post('/internal/jobs/cleanup').set('X-Cron-Secret', 'x')).status).toBe(401);
  });

  it('rate-limits place search per user', async () => {
    const app = createApp(deps());
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (await request(app).get(`/v1/places/autocomplete?q=abc${i}`).set('Authorization', 'Bearer good'))
        .status;
    }
    expect(last).toBe(429);
  });
});

describe('upstream error reporting', () => {
  it('keeps Google error reasons for the logs', async () => {
    const client = new PlacesClient(
      'key',
      undefined,
      (async () =>
        jsonResponse(
          { error: { code: 403, details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } },
          403,
        )) as unknown as typeof fetch,
    );
    await expect(client.autocomplete({ query: 'abc' })).rejects.toMatchObject({
      status: 502,
      message: 'Google 403: API_KEY_HTTP_REFERRER_BLOCKED',
    });
  });

  it('treats Geocoding REQUEST_DENIED as an upstream error', async () => {
    const client = new PlacesClient(
      'key',
      undefined,
      (async () =>
        jsonResponse({ status: 'REQUEST_DENIED', error_message: 'API keys with referer restrictions cannot be used' })) as unknown as typeof fetch,
    );
    await expect(client.reverseGeocode(1, 2)).rejects.toMatchObject({ status: 502 });
  });
});
