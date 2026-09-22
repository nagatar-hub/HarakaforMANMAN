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
};

export function buildTokyoPelekaCatalog(params: {
  runId: string;
  snapshotId: string;
  businessDate: string;
  generatedAt: string;
  cards: PreparedCardRow[];
}) {
  const products: PelekaCatalogProduct[] = params.cards.map(card => {
    const sourceId = card.source_shinsoku_id?.trim();
    const imageUrl = (card.image_url || card.alt_image_url)?.trim();
    if (!sourceId || !imageUrl || !card.card_name.trim() || !card.price_high
      || card.price_low === null || card.price_low === undefined || card.price_low < 0 || card.price_low > card.price_high) {
      throw new Error(`Peleka掲載商品データが不完全です: prepared_card=${card.id}`);
    }
    return {
      sourceId,
      franchise: card.franchise,
      productType: card.tag === 'BOX' || card.grade === 'BOX' || card.grade === '未開封BOX' ? 'BOX' as const : 'PSA10' as const,
      name: card.card_name,
      modelNumber: card.list_no,
      imageUrl,
      priceHigh: card.price_high,
      priceLow: card.price_low,
    };
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
    count: products.length,
    productsSha256: createHash('sha256').update(JSON.stringify(products)).digest('hex'),
    products,
  };
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
