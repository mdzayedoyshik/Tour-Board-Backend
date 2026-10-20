import { HttpError } from '../middleware/errors.js';

import type { UsageGuard, Sku } from './usage.js';

export type Suggestion = { placeId: string; primary: string; secondary: string };
export type Place = { placeId?: string; name: string; address: string; lat: number; lng: number };

type Fetch = typeof fetch;

/** Small TTL cache; keeps repeated searches off the paid API. */
class TtlCache<T> {
  private readonly map = new Map<string, { value: T; expires: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

/**
 * Google Places API (New) + Geocoding, called server-side so the key never
 * ships in the app. Session tokens group autocomplete + details into one
 * billable session, as Google recommends.
 */
export class PlacesClient {
  private readonly suggestions = new TtlCache<Suggestion[]>(500, 10 * 60_000);
  private readonly places = new TtlCache<Place>(1000, 24 * 60 * 60_000);

  constructor(
    private readonly apiKey: string | undefined,
    private readonly usage?: UsageGuard,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async spend(sku: Sku) {
    if (this.usage && !(await this.usage.tryConsume(sku))) {
      throw new HttpError(429, 'quota-exceeded');
    }
  }

  get available() {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) throw new HttpError(503, 'places-unavailable');
    return this.apiKey;
  }

  async autocomplete(input: {
    query: string;
    language?: string;
    session?: string;
    lat?: number;
    lng?: number;
  }): Promise<Suggestion[]> {
    const key = this.requireKey();
    const cacheKey = [input.query.toLowerCase(), input.language, input.lat?.toFixed(2), input.lng?.toFixed(2)].join('|');
    const cached = this.suggestions.get(cacheKey);
    if (cached) return cached;
    await this.spend('autocomplete');
    const body: Record<string, unknown> = { input: input.query };
    if (input.language) body.languageCode = input.language;
    if (input.session) body.sessionToken = input.session;
    if (input.lat !== undefined && input.lng !== undefined) {
      body.locationBias = {
        circle: { center: { latitude: input.lat, longitude: input.lng }, radius: 50_000 },
      };
    }
    const res = await this.fetchImpl('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await this.checked(res)) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        };
      }>;
    };
    const result = (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
      .map((p) => ({
        placeId: p.placeId!,
        primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary: p.structuredFormat?.secondaryText?.text ?? '',
      }))
      .filter((s) => s.primary);
    this.suggestions.set(cacheKey, result);
    return result;
  }

  async details(placeId: string, opts: { language?: string; session?: string } = {}): Promise<Place> {
    const key = this.requireKey();
    const cacheKey = `${placeId}|${opts.language ?? ''}`;
    const cached = this.places.get(cacheKey);
    if (cached) return cached;
    await this.spend('placeDetails');
    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
    if (opts.language) url.searchParams.set('languageCode', opts.language);
    if (opts.session) url.searchParams.set('sessionToken', opts.session);
    const res = await this.fetchImpl(url, {
      headers: {
        'X-Goog-Api-Key': key,
        // Essentials fields only: displayName would bill as Place Details
        // Pro (smaller free cap). The app already has the name from the
        // autocomplete suggestion.
        'X-Goog-FieldMask': 'id,formattedAddress,shortFormattedAddress,location',
      },
      signal: AbortSignal.timeout(8000),
    });
    const json = (await this.checked(res)) as {
      id?: string;
      formattedAddress?: string;
      shortFormattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };
    const lat = json.location?.latitude;
    const lng = json.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') throw new HttpError(404, 'not-found');
    const place: Place = {
      placeId: json.id ?? placeId,
      name: (json.shortFormattedAddress ?? json.formattedAddress ?? '').split(',')[0]?.trim() ?? '',
      address: json.formattedAddress ?? '',
      lat,
      lng,
    };
    this.places.set(cacheKey, place);
    return place;
  }

  async reverseGeocode(lat: number, lng: number, language?: string): Promise<Place> {
    const key = this.requireKey();
    // ~11 m grid so nearby taps share a cache entry.
    const cacheKey = `rev|${lat.toFixed(4)}|${lng.toFixed(4)}|${language ?? ''}`;
    const cached = this.places.get(cacheKey);
    if (cached) return cached;
    await this.spend('geocoding');
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('key', key);
    if (language) url.searchParams.set('language', language);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    const json = (await this.checked(res)) as {
      status?: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{ long_name?: string; types?: string[] }>;
      }>;
    };
    if (json.status === 'OVER_QUERY_LIMIT') throw new HttpError(429, 'rate-limited');
    const first = json.results?.[0];
    const named = first?.address_components?.find((c) =>
      c.types?.some((t) => ['point_of_interest', 'establishment', 'premise', 'route', 'neighborhood', 'locality'].includes(t)),
    );
    const place: Place = {
      name: named?.long_name ?? first?.formatted_address?.split(',')[0] ?? '',
      address: first?.formatted_address ?? '',
      lat,
      lng,
    };
    this.places.set(cacheKey, place);
    return place;
  }

  private async checked(res: Response): Promise<unknown> {
    if (res.status === 429) throw new HttpError(429, 'rate-limited');
    if (!res.ok) {
      // Keep Google's reason (e.g. API_KEY_HTTP_REFERRER_BLOCKED) for the
      // server log; clients only see a generic code.
      const body = await res.text().catch(() => '');
      const reason = /"reason":\s*"([A-Z_]+)"/.exec(body)?.[1] ?? /"message":\s*"([^"]+)"/.exec(body)?.[1];
      throw new HttpError(502, 'places-upstream-error', `Google ${res.status}: ${reason ?? 'unknown'}`);
    }
    const json = (await res.json()) as { status?: string; error_message?: string };
    // The Geocoding API reports key problems with HTTP 200 + status.
    if (json.status === 'REQUEST_DENIED') {
      throw new HttpError(502, 'places-upstream-error', `Google REQUEST_DENIED: ${json.error_message ?? ''}`);
    }
    return json;
  }
}
