import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export type Sku = 'autocomplete' | 'placeDetails' | 'geocoding';

/**
 * Monthly hard caps kept below Google's free allowances (verified
 * 2026-10-20: Autocomplete Requests 10,000; Place Details Essentials
 * 10,000; Geocoding 10,000 per month). Autocomplete in a session that ends
 * in Place Details is free, but sessions can be abandoned, so autocomplete
 * is capped too.
 */
export const monthlyCaps: Record<Sku, number> = {
  autocomplete: 9000,
  placeDetails: 9000,
  geocoding: 9000,
};

/**
 * Counts paid Google calls per calendar month in Firestore
 * (serverMeta/mapsUsage-YYYY-MM) so limits survive restarts. Each call costs
 * one Firestore write; the counter is re-read at most once a minute.
 */
export class UsageGuard {
  private cache: { month: string; counts: Partial<Record<Sku, number>>; readAt: number } | undefined;

  constructor(
    private readonly db: Firestore,
    private readonly caps: Record<Sku, number> = monthlyCaps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private month() {
    return this.now().toISOString().slice(0, 7);
  }

  async tryConsume(sku: Sku): Promise<boolean> {
    const month = this.month();
    const ref = this.db.doc(`serverMeta/mapsUsage-${month}`);
    if (!this.cache || this.cache.month !== month || Date.now() - this.cache.readAt > 60_000) {
      const snap = await ref.get();
      this.cache = { month, counts: (snap.data() ?? {}) as Partial<Record<Sku, number>>, readAt: Date.now() };
    }
    const used = this.cache.counts[sku] ?? 0;
    if (used >= this.caps[sku]) return false;
    this.cache.counts[sku] = used + 1;
    await ref.set({ [sku]: FieldValue.increment(1) }, { merge: true });
    return true;
  }
}
