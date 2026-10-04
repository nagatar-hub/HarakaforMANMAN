import { createHash } from 'node:crypto';
import type { PreparedCardRow } from '@haraka/shared';
import { fetchWithRetry } from './fetch-with-retry.js';

export type PelekaCatalogProduct = {
  sourceId: string;
  franchise: string;
  productType: 'PSA10' | 'BOX';
  name: string;
  modelNumber: string | null;
  imageUrl: string;
  priceHigh: number;
  priceLow: number;
  /** シンソク郵送買取の元価格。Peleka は Haraka の掲載価格ではなくこれに自店の価格倍率を掛ける。 */
  shinsokuPrice: number;
};

export function buildTokyoPelekaCatalog(params: {
  runId: string;
  snapshotId: string;
  businessDate: string;
  generatedAt: string;
  revision?: number;
  cards: PreparedCardRow[];
  /** スナップショット商品ID -> シンソク元価格。シンソクに価格が無い商品は Peleka に載せない。 */
  shinsokuPrices: ReadonlyMap<string, number>;
}) {
  const products: PelekaCatalogProduct[] = params.cards.flatMap(card => {
    const sourceId = card.source_shinsoku_id?.trim();
    const shinsokuPrice = sourceId ? params.shinsokuPrices.get(sourceId) : undefined;
    if (shinsokuPrice === undefined) return [];
    const imageUrl = (card.image_url || card.alt_image_url)?.trim();
    if (!sourceId || !imageUrl || !card.card_name.trim() || !card.price_high
      || card.price_low === null || card.price_low === undefined || card.price_low < 0 || card.price_low > card.price_high) {
      throw new Error(`Peleka掲載商品データが不完全です: prepared_card=${card.id}`);
    }
    return [{
      sourceId,
      franchise: card.franchise,
      productType: card.tag === 'BOX' || card.grade === 'BOX' || card.grade === '未開封BOX' ? 'BOX' as const : 'PSA10' as const,
      name: card.card_name,
      modelNumber: card.list_no,
      imageUrl,
      priceHigh: card.price_high,
      priceLow: card.price_low,
      shinsokuPrice,
    }];
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (new Set(products.map(product => product.sourceId)).size !== products.length) {
    throw new Error('Peleka掲載商品にsourceId重複があります');
  }
  return {
    store: 'manman-akihabara' as const,
    runId: params.runId,
    snapshotId: params.snapshotId,
    businessDate: params.businessDate,
    generatedAt: params.generatedAt,
    revision: params.revision ?? 0,
    count: products.length,
    productsSha256: createHash('sha256').update(JSON.stringify(products)).digest('hex'),
    products,
  };
}

const validSourcePrice = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;

/** 比較で外れ値として除外されたシンソク価格は使わない（価格無しと同じ扱い）。 */
export async function loadTokyoShinsokuPrices(
  supabase: { from: unknown },
  snapshotId: string,
  sourceIds: string[],
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const ids = [...new Set(sourceIds)];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await (supabase.from as (table: string) => {
      select: (columns: string) => { eq: (column: string, value: string) => {
        in: (column: string, values: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } };
    })('tokyo_buyback_product').select('id,origins').eq('snapshot_id', snapshotId).in('id', ids.slice(offset, offset + 100));
    if (error) throw new Error(`シンソク元価格の取得失敗: ${error.message}`);
    for (const row of (data ?? []) as { id: string; origins: unknown }[]) {
      const origin = Array.isArray(row.origins)
        ? (row.origins as Record<string, unknown>[]).find(item => item?.source === 'shinsoku') : undefined;
      if (origin && origin.excluded !== true && validSourcePrice(origin.rawPrice)) prices.set(row.id, origin.rawPrice);
    }
  }
  return prices;
}

type TokyoPelekaCatalogSnapshot = {
  runId: string;
  snapshotId: string;
  businessDate: string;
  generatedAt: string;
  revision: number;
  cards: PreparedCardRow[];
};

export async function buildCurrentTokyoPelekaCatalog(
  supabase: { rpc: unknown; from: unknown },
  runId: string,
  regeneratingPageId?: string,
) {
  const params: Record<string, unknown> = { p_run_id: runId };
  if (regeneratingPageId) params.p_regenerating_page_id = regeneratingPageId;
  const { data, error } = await (supabase.rpc as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>)(
    'allocate_tokyo_peleka_catalog_revision', params,
  );
  if (error || !data) throw new Error(`Pelekaカタログスナップショット取得失敗: ${error?.message ?? '該当なし'}`);
  const snapshot = data as TokyoPelekaCatalogSnapshot;
  const shinsokuPrices = await loadTokyoShinsokuPrices(supabase, snapshot.snapshotId,
    snapshot.cards.flatMap(card => card.source_shinsoku_id?.trim() ? [card.source_shinsoku_id.trim()] : []));
  return buildTokyoPelekaCatalog({ ...snapshot, shinsokuPrices });
}

export async function publishTokyoPelekaCatalog(
  endpoint: string,
  token: string,
  payload: ReturnType<typeof buildTokyoPelekaCatalog>,
) {
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Pelekaカタログ反映失敗: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
}

export async function publishCurrentTokyoPelekaCatalog(
  supabase: Parameters<typeof buildCurrentTokyoPelekaCatalog>[0],
  runId: string,
  endpoint: string,
  token: string,
  regeneratingPageId?: string,
) {
  const payload = await buildCurrentTokyoPelekaCatalog(supabase, runId, regeneratingPageId);
  await publishTokyoPelekaCatalog(endpoint, token, payload);
  return payload;
}
