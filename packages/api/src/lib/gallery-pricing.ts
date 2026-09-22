import type { SupabaseClient } from '@supabase/supabase-js';
import { tokyoBusinessDate } from '@haraka/shared';

export type GalleryCardPricing = {
  listings: { store: string; price: number | null }[];
  adopted: { store: string | null; price: number | null } | null;
  comparison?: {
    rows: { store: string; rawPrice: number; highRate: number; highPrice: number;
      lowRate: number; lowPrice: number; selectedHigh: boolean; selectedLow: boolean }[];
    high: { store: string; price: number };
    low: { store: string; price: number };
  };
};
type Card = { id: string; run_id: string; source_shinsoku_id: string | null };
type Origin = { source?: string; id?: string; sourcePrice?: unknown; rawPrice?: unknown;
  highRate?: unknown; highPrice?: unknown; lowRate?: unknown; lowPrice?: unknown };
const labels: Record<string, string> = {
  kecak: 'KECAK', blue_rocket: 'Blue Rocket', avirile: 'アヴィリール',
  toreca_bank: 'トレカバンク', shinsoku: 'シンソク郵送買取',
};
const price = (value: unknown): number | null => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : null;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const rate = (value: unknown): number | null => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const isTokyoBusinessDate = (value: unknown, businessDate: unknown): boolean => {
  if (typeof value !== 'string' || typeof businessDate !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && tokyoBusinessDate(date) === businessDate;
};

/** Use each card's immutable generation snapshot, never today's catalog or a name match. */
export async function loadTokyoGalleryPricing(db: SupabaseClient, cards: Card[]): Promise<Map<string, GalleryCardPricing>> {
  const result = new Map(cards.map(card => [card.id, { listings: [], adopted: null } as GalleryCardPricing]));
  if (!cards.length) return result;
  const { data: runs, error: runError } = await db.from('run').select('id,tokyo_snapshot_id')
    .eq('store', 'manman-akihabara').in('id', [...new Set(cards.map(card => card.run_id))]);
  if (runError) throw new Error(runError.message);
  const runSnapshots = new Map((runs ?? []).map(run => [run.id, run.tokyo_snapshot_id]));
  const snapshotIds = [...new Set((runs ?? []).map(run => run.tokyo_snapshot_id).filter(Boolean))];
  if (!snapshotIds.length) return result;
  const { data: snapshots, error: snapshotError } = await db.from('tokyo_buyback_snapshot')
    .select('id,checker_run_id,checker_source_store,order_list_import_id,business_date,report')
    .eq('store', 'manman-akihabara').in('id', snapshotIds);
  if (snapshotError) throw new Error(snapshotError.message);
  for (const snapshot of snapshots ?? []) {
    const report = object(snapshot.report);
    const snapshotCards = cards.filter(card => runSnapshots.get(card.run_id) === snapshot.id);
    const ids = [...new Set(snapshotCards.map(card => card.source_shinsoku_id).filter(Boolean))];
    if (!ids.length) continue;
    const { data: products, error: productError } = await db.from('tokyo_buyback_product')
      .select('id,source_price,price_high,price_low,selected_high_source,selected_low_source,origins')
      .eq('snapshot_id', snapshot.id).in('id', ids);
    if (productError) throw new Error(productError.message);
    const origins = (row: { origins: unknown }): Origin[] => Array.isArray(row.origins)
      ? row.origins.map(value => object(value) as Origin) : [];
    const allOrigins = (products ?? []).flatMap(origins);
    let kecakImport: { id: string; business_date: string } | null = null;
    if (snapshot.order_list_import_id && allOrigins.some(origin => origin.source === 'kecak')) {
      const { data, error } = await db.from('order_list_import').select('id,business_date')
        .eq('id', snapshot.order_list_import_id).eq('store', 'manman-akihabara').maybeSingle();
      if (error) throw new Error(error.message);
      kecakImport = data;
    }
    const hasCurrentKecakPrices = kecakImport?.business_date === snapshot.business_date;
    const checkerIds = [...new Set(allOrigins.filter(origin => ['avirile', 'toreca_bank'].includes(origin.source ?? ''))
      .flatMap(origin => typeof origin.id === 'string' && /^\d+:\d+:\d+$/.test(origin.id) ? [Number(origin.id.split(':')[0])] : []))];
    const offers = new Map<string, number | null>();
    if (snapshot.checker_run_id && snapshot.checker_source_store === 'oripark' && checkerIds.length) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from('kaitori_checker_offer_snapshot')
          .select('source_product_id,shop_id,condition_id,edition_id,buy_price,source_updated_at')
          .eq('run_id', snapshot.checker_run_id).eq('store', snapshot.checker_source_store)
          .in('source_product_id', checkerIds).in('shop_id', [3, 13])
          .order('source_product_id').order('shop_id').order('condition_id').order('edition_id')
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        for (const offer of data ?? []) {
          if (isTokyoBusinessDate(offer.source_updated_at, snapshot.business_date)) {
            offers.set(`${offer.shop_id}:${offer.source_product_id}:${offer.condition_id}:${offer.edition_id}`, price(offer.buy_price));
          }
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    }
    const missingKecakIds = hasCurrentKecakPrices
      ? [...new Set(allOrigins.filter(origin => origin.source === 'kecak'
        && !Object.hasOwn(origin, 'sourcePrice') && typeof origin.id === 'string').map(origin => origin.id))]
      : [];
    const kecakPrices = new Map<string, number | null>();
    if (missingKecakIds.length && kecakImport) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from('order_list_item').select('id,excel_product_id,source_price')
          .eq('import_id', kecakImport.id).in('excel_product_id', missingKecakIds).order('id').range(offset, offset + 999);
        if (error) throw new Error(error.message);
        for (const item of data ?? []) {
          const previous = kecakPrices.get(item.excel_product_id);
          const next = price(item.source_price);
          // Duplicate exact IDs with conflicting prices cannot establish a historical price.
          kecakPrices.set(item.excel_product_id, previous === undefined || previous === next ? next : null);
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    }
    const priceSources = object(report.price_sources);
    for (const product of products ?? []) {
      const provenance = object(priceSources[product.id]);
      const productOrigins = origins(product);
      const comparisonRows = productOrigins.flatMap(origin => {
        const store = labels[origin.source ?? ''];
        const rawPrice = price(origin.rawPrice);
        const highRate = rate(origin.highRate);
        const highPrice = price(origin.highPrice);
        const lowRate = rate(origin.lowRate);
        const lowPrice = typeof origin.lowPrice === 'number' && Number.isSafeInteger(origin.lowPrice)
          && origin.lowPrice >= 0 && origin.lowPrice <= 100_000_000 ? origin.lowPrice : null;
        return store && rawPrice !== null && highRate !== null && highPrice !== null && lowRate !== null && lowPrice !== null
          ? [{ store, rawPrice, highRate, highPrice, lowRate, lowPrice,
            selectedHigh: origin.source === product.selected_high_source,
            selectedLow: origin.source === product.selected_low_source }] : [];
      });
      if (comparisonRows.length && comparisonRows.some(row => row.selectedHigh) && comparisonRows.some(row => row.selectedLow)) {
        const high = comparisonRows.find(row => row.selectedHigh)!;
        const low = comparisonRows.find(row => row.selectedLow)!;
        const pricing: GalleryCardPricing = {
          listings: comparisonRows.map(row => ({ store: row.store, price: row.rawPrice })),
          adopted: { store: high.store, price: high.rawPrice },
          comparison: { rows: comparisonRows, high: { store: high.store, price: high.highPrice },
            low: { store: low.store, price: low.lowPrice } },
        };
        for (const card of snapshotCards.filter(card => card.source_shinsoku_id === product.id)) result.set(card.id, pricing);
        continue;
      }
      const adoptedPrice = price(product.source_price);
      const provenSource = (provenance.source === 'kecak' || provenance.source === 'shinsoku')
        && price(provenance.price) === adoptedPrice && adoptedPrice !== null ? String(provenance.source) : null;
      const adoptedStore = provenSource ? labels[provenSource] : null;
      const listings: GalleryCardPricing['listings'] = [];
      for (const origin of productOrigins) {
        const store = labels[origin.source ?? ''];
        if (!store) continue;
        if (origin.source === 'kecak' && !hasCurrentKecakPrices) continue;
        let amount: number | null = null;
        if (origin.source === 'kecak') amount = Object.hasOwn(origin, 'sourcePrice')
          ? price(origin.sourcePrice) : kecakPrices.get(origin.id ?? '') ?? null;
        if (origin.source === 'avirile' || origin.source === 'toreca_bank') {
          amount = offers.get(`${origin.source === 'avirile' ? 13 : 3}:${origin.id}`) ?? null;
        }
        if (origin.source === 'shinsoku' && provenSource === 'shinsoku') amount = adoptedPrice;
        if (amount === null) continue;
        if (!listings.some(row => row.store === store && row.price === amount)) listings.push({ store, price: amount });
      }
      const pricing: GalleryCardPricing = { listings, adopted: { store: adoptedStore, price: adoptedPrice } };
      for (const card of snapshotCards.filter(card => card.source_shinsoku_id === product.id)) result.set(card.id, pricing);
    }
  }
  return result;
}
