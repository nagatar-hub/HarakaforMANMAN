import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { postalProductIdentity, tokyoBoxAliasName, type PreparedCardRow } from '@haraka/shared';
import type { TokyoCandidate, compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync.js';

export type CoverageCard = {
  id: string; franchise: string; card_name: string; list_no: string | null; grade: string | null;
  tag: string | null; rarity: string | null; image_url: string | null; alt_image_url: string | null;
  excel_product_id: string | null; source: string; db_card?: { card_name: string } | null;
  raw_import: { source_price: number | null; price_source: string | null; raw_row?: Record<string, unknown> | null } | null;
};
export type OriparkCoverage = { runId: string; businessDate: string; fingerprint: string; cards: CoverageCard[] };
export type CoverageItem = { oriparkCardId: string; productId: string; imageUrl: string;
  altImageUrl: string | null; tag: string | null; rarity: string | null;
  edition?: { sourceProductId: string; name: string; expansion: string } };
export type CoverageReport = { version: 1; runId: string; businessDate: string; fingerprint: string; items: CoverageItem[] };
type Comparison = ReturnType<typeof compareTokyoSourceProducts>;

async function pages<T>(db: SupabaseClient, table: string, runId: string, select: string): Promise<T[]> {
  const result: T[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await db.from(table).select(select).eq('run_id', runId).order('id').range(start, start + 499);
    if (error) throw new Error(`Oripark coverage ${table}: ${error.message}`);
    result.push(...(data ?? []) as unknown as T[]);
    if ((data?.length ?? 0) < 500) return result;
  }
}

/** Only already-published products are shared. No account/configuration or draft data crosses stores. */
export async function loadOriparkCoverage(db: SupabaseClient): Promise<OriparkCoverage> {
  const { data: run, error } = await db.from('run').select('id,order_list_import_id')
    .eq('store', 'oripark').eq('status', 'completed').not('generate_done_at', 'is', null)
    .order('started_at', { ascending: false }).order('id').limit(1).maybeSingle();
  if (error || !run?.order_list_import_id) throw new Error(`Oripark掲載基準Runがありません: ${error?.message ?? ''}`);
  const [catalog, cards, order] = await Promise.all([
    pages<{ status: string; kind: string; card_ids: string[] }>(db, 'generated_page', run.id, 'id,status,kind,card_ids'),
    pages<CoverageCard>(db, 'prepared_card', run.id,
      'id,franchise,card_name,list_no,grade,tag,rarity,image_url,alt_image_url,excel_product_id,source,raw_import(source_price,price_source,raw_row),db_card(card_name)'),
    db.from('order_list_import').select('business_date').eq('id', run.order_list_import_id).eq('store', 'oripark').single(),
  ]);
  if (order.error || !order.data) throw new Error('Oripark掲載基準の業務日がありません');
  const published = new Set(catalog.filter(p => p.status === 'generated' && ['store', 'postal'].includes(p.kind))
    .flatMap(p => p.card_ids));
  const selected = cards.filter(card => published.has(card.id));
  if (!published.size || selected.length !== published.size) throw new Error('Oripark掲載商品とprepared_cardが一致しません');
  const basis = { runId: run.id as string, businessDate: order.data.business_date as string, cards: selected };
  return { ...basis, fingerprint: createHash('sha256').update(JSON.stringify(basis)).digest('hex') };
}

const typeOf = (card: CoverageCard) => card.tag === 'BOX' || /BOX/i.test(card.grade ?? '') ? 'BOX' as const : 'PSA10' as const;
const identity = (row: { franchise: string; name: string; modelNumber: string | null; productType: 'PSA10' | 'BOX' }) =>
  postalProductIdentity({ ...row, name: tokyoBoxAliasName(row) });

function keys(card: CoverageCard): Set<string> {
  const row = { franchise: card.franchise, name: card.card_name, modelNumber: card.list_no, productType: typeOf(card) };
  const names = [card.card_name, card.db_card?.card_name].filter((name): name is string => !!name);
  // Match these variants only with the explicit Oripark DB evidence, never by number alone.
  if (card.franchise === 'Pokemon' && card.tag === 'イーブイ/マスボ' && card.list_no === '051/187') names.push('サンダース(マスターボールミラー)');
  if (card.franchise === 'Pokemon' && card.list_no === '076/SM-P'
    && card.db_card?.card_name === 'サトシのピカチュウ(青背景、アローラ)') names.push('サトシのピカチュウ(アローラキャップver)');
  return new Set(names.map(name => identity({ ...row, name })));
}

const expansionOf = (card: CoverageCard): string | null => {
  const value = card.raw_import?.raw_row?.['エキスパンション'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};
const editionImageOf = (card: CoverageCard): string | null => {
  const raw = card.raw_import?.raw_row;
  if (raw?.['商品ID'] != null && raw['商品ID'] !== card.excel_product_id) return null;
  // The source row can prove an image even when the DB matcher supplied another edition's image.
  const original = raw?.['画像'];
  const image = typeof original === 'string' && original.trim() ? original.trim() : card.image_url;
  return image?.startsWith('https://') ? image : null;
};
const exactSourceMatch = (card: CoverageCard, product: Comparison['products'][number]): boolean =>
  card.source === 'order_list' && !!card.excel_product_id && product.franchise === card.franchise
  && product.product_type === (typeOf(card) === 'BOX' ? 'box' : 'psa')
  && product.origins.some(origin => origin.source === 'kecak' && origin.id === card.excel_product_id);

/** Published rows with separate source IDs and artwork must not share a name-based price. */
function separatedEditions(cards: CoverageCard[], products: Comparison['products']): Map<string, NonNullable<CoverageItem['edition']>> {
  const groups = new Map<string, CoverageCard[]>();
  for (const card of cards) for (const key of keys(card)) groups.set(key, [...(groups.get(key) ?? []), card]);
  const peers = new Map<string, Set<CoverageCard>>();
  for (const group of groups.values()) {
    if (new Set(group.map(card => card.excel_product_id)).size < 2
      || new Set(group.map(card => editionImageOf(card) ?? card.image_url ?? card.alt_image_url)).size < 2
      || group.some(card => card.source !== 'order_list' || typeOf(card) !== 'PSA10' || !card.excel_product_id
        || card.raw_import?.price_source !== 'order_list' || !expansionOf(card))) continue;
    const existing = group.map(card => {
      const matches = products.filter(product => coverageMatches(card, product));
      const exact = matches.filter(product => exactSourceMatch(card, product));
      return exact.length === 1 ? exact : matches;
    });
    // Existing independent identities already distinguish these rows; do not relabel their editions.
    if (existing.every(matches => matches.length === 1)
      && new Set(existing.map(matches => matches[0].id)).size === group.length) continue;
    if (group.some(card => !editionImageOf(card))) throw new Error('Oripark別版の元商品ID・主画像を確認できません');
    for (const card of group) {
      const related = peers.get(card.id) ?? new Set<CoverageCard>();
      for (const other of group) related.add(other);
      peers.set(card.id, related);
    }
  }
  return new Map(cards.flatMap(card => {
    const related = peers.get(card.id);
    if (!related) return [];
    const expansion = expansionOf(card)!;
    const sourceId = card.excel_product_id!;
    const sharedLabel = [...related].some(other => other.excel_product_id !== sourceId && expansionOf(other) === expansion);
    const shortId = [...related].some(other => other.excel_product_id !== sourceId
      && other.excel_product_id!.slice(0, 8) === sourceId.slice(0, 8)) ? sourceId : sourceId.slice(0, 8);
    const name = `${card.card_name} [${expansion}${sharedLabel ? ` / 元商品ID:${shortId}` : ''}]`;
    return [[card.id, { sourceProductId: sourceId, expansion, name }] as const];
  }));
}

export function coverageMatches(card: CoverageCard, product: Comparison['products'][number]): boolean {
  const productType = product.product_type === 'box' ? 'BOX' : 'PSA10';
  if (product.franchise !== card.franchise || productType !== typeOf(card)) return false;
  if (exactSourceMatch(card, product)) return true;
  const expected = keys(card);
  return [identity({ franchise: product.franchise, name: product.name, modelNumber: product.model_number, productType }),
    ...product.origins.map(o => identity(o))].some(key => expected.has(key));
}

/** Fill absent products. Exact Tokyo source prices stay immutable; colliding editions get their own evidence. */
export function completeOriparkCoverage(result: Comparison, baseline: OriparkCoverage, businessDate: string,
  maxAgeDays: number, compareOne: (candidate: TokyoCandidate) => Comparison): CoverageReport {
  const age = (Date.parse(`${businessDate}T00:00:00+09:00`) - Date.parse(`${baseline.businessDate}T00:00:00+09:00`)) / 86400000;
  const editions = separatedEditions(baseline.cards, result.products);
  const items: CoverageItem[] = [];
  for (const card of baseline.cards) {
    const edition = editions.get(card.id);
    let matches = result.products.filter(product => edition ? exactSourceMatch(card, product) : coverageMatches(card, product));
    if (matches.length > 1) {
      // A shared source product ID is stronger evidence than names that may collapse variants.
      const byId = matches.filter(product => exactSourceMatch(card, product));
      if (byId.length === 1) matches = byId;
      else throw new Error(`Oripark掲載商品が東京の複数商品に対応します: ${card.id} ${card.card_name}`);
    }
    if (edition && matches.length === 1) {
      const product = matches[0];
      const own = product.origins.filter(origin => origin.source === 'kecak' && origin.id === edition.sourceProductId);
      if (product.origins.length !== own.length) {
        if (own.length !== 1) throw new Error(`Oripark別版の元価格が曖昧です: ${card.id}`);
        // An exact KECAK ID proves this edition; a generic name match from another source does not.
        const origin = own[0];
        const specific = compareOne({ source: origin.source, id: origin.id, franchise: origin.franchise,
          name: edition.name, modelNumber: origin.modelNumber, productType: origin.productType,
          observedAt: origin.observedAt, sourcePrice: origin.rawPrice });
        if (specific.products.length !== 1) throw new Error(`Oripark別版の元価格を比較できません: ${card.id}`);
        const source = specific.priceSources[specific.products[0].id];
        Object.assign(product, { ...specific.products[0], id: product.id });
        result.priceSources[product.id] = source;
      }
    }
    if (!matches.length) {
      if (!Number.isInteger(age) || age < 0 || age > maxAgeDays) throw new Error(`Oripark補完価格の鮮度が不足しています: ${baseline.businessDate} ${card.card_name}`);
      // Oripark keeps order_list as the import origin even when its BOX price
      // was replaced. The price provenance, not the import origin, selects Tokyo's rate.
      const override = typeOf(card) === 'BOX' ? card.raw_import?.raw_row?.pokemon_box_price_source : null;
      if (override != null && override !== 'BOX_PRICE_DB') {
        throw new Error(`Oripark補完商品の元価格を特定できません: ${card.id}`);
      }
      const source = override === 'BOX_PRICE_DB' ? 'shinsoku'
        : card.raw_import?.price_source === 'order_list' ? 'kecak' : card.raw_import?.price_source;
      if (!['kecak', 'shinsoku', 'extoreca'].includes(source ?? '') || !card.excel_product_id) throw new Error(`Oripark補完商品の元価格を特定できません: ${card.id}`);
      const single = compareOne({ source: source as TokyoCandidate['source'], id: card.excel_product_id,
        franchise: card.franchise, name: edition?.name ?? card.card_name, modelNumber: card.list_no, productType: typeOf(card),
        sourcePrice: card.raw_import!.source_price, observedAt: `${baseline.businessDate}T00:00:00+09:00` });
      if (edition && single.products.length === 1) {
        const previousId = single.products[0].id;
        const productId = `TOKYO_${createHash('sha256').update(JSON.stringify([
          'oripark-source-edition-v1', card.franchise, typeOf(card), source, card.excel_product_id,
        ])).digest('hex')}`;
        single.products[0].id = productId;
        single.priceSources[productId] = single.priceSources[previousId];
        if (productId !== previousId) delete single.priceSources[previousId];
      }
      if (single.products.length !== 1 || result.products.some(p => p.id === single.products[0].id)) {
        throw new Error(`Oripark掲載商品の価格・同一性を補完できません: ${card.id} ${card.card_name}`);
      }
      result.products.push(single.products[0]);
      Object.assign(result.priceSources, single.priceSources);
      matches = single.products;
    }
    const imageUrl = edition ? editionImageOf(card) : card.image_url || card.alt_image_url;
    if (!imageUrl?.startsWith('https://')) throw new Error(`Oripark掲載画像がありません: ${card.id}`);
    if (edition) {
      matches[0].name = edition.name;
      matches[0].image_url = imageUrl;
    }
    items.push({ oriparkCardId: card.id, productId: matches[0].id, imageUrl,
      altImageUrl: edition ? null : card.alt_image_url, tag: card.tag, rarity: card.rarity,
      ...(edition ? { edition } : {}) });
  }
  return { version: 1, runId: baseline.runId, businessDate: baseline.businessDate, fingerprint: baseline.fingerprint, items };
}

export function readCoverageReport(report: unknown): CoverageReport | null {
  const value = (report as { oripark_coverage?: CoverageReport } | null)?.oripark_coverage;
  if (!value) return null;
  if (value.version !== 1 || !value.runId || !value.fingerprint || !Array.isArray(value.items) || !value.items.length
    || value.items.some(item => !item.productId || !item.oriparkCardId || !item.imageUrl?.startsWith('https://')
      || item.edition && (!item.edition.sourceProductId || !item.edition.name || !item.edition.expansion))) {
    throw new Error('Oripark掲載網羅レポートが不正です');
  }
  return value;
}

export function assertOriparkCoverage(report: CoverageReport, cards: Pick<PreparedCardRow, 'source_shinsoku_id'>[]): void {
  const editionSources = new Map<string, string>();
  for (const item of report.items) if (item.edition) {
    const previous = editionSources.get(item.productId);
    if (previous && previous !== item.edition.sourceProductId) throw new Error(`Oripark別版の商品IDが重複しています: ${item.productId}`);
    editionSources.set(item.productId, item.edition.sourceProductId);
  }
  const ids = new Set(cards.map(card => card.source_shinsoku_id));
  const missing = report.items.filter(item => !ids.has(item.productId));
  if (missing.length) throw new Error(`Oripark掲載商品が東京から欠落します: ${missing.length}件 (${missing.slice(0, 5).map(item => item.oriparkCardId).join(',')})`);
}
