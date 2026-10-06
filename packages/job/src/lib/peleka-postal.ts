import type { PreparedCardRow } from '@haraka/shared';
import { fetchWithRetry } from './fetch-with-retry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FINGERPRINT = /^[0-9a-f]{32}$/u;
const FRANCHISES = new Set(['Pokemon', 'ONE PIECE', 'YU-GI-OH!', 'WEISS SCHWARZ', 'DRAGON BALL']);

export type TokyoPelekaPostalProduct = {
  sourceId: string;
  franchise: string;
  productType: 'PSA10' | 'BOX';
  name: string;
  modelNumber: string | null;
  imageUrl: string;
  priceHigh: number;
  priceLow: number;
};

export type TokyoPelekaPostalSnapshot = {
  schemaVersion: 1;
  store: 'manman-akihabara';
  runId: string;
  snapshotId: string;
  revision: number;
  businessDate: string;
  generatedAt: string;
  buyPriceDisplayMode: 'UPPER_ONLY' | 'RANGE';
  boxBuybackEnabled: boolean;
  products: TokyoPelekaPostalProduct[];
  fingerprint: string;
};

export type TokyoPelekaPostalPageSnapshot = Omit<TokyoPelekaPostalSnapshot, 'products'> & {
  products: TokyoPelekaPostalProduct[];
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positivePrice(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativePrice(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseTokyoPelekaPostalSnapshot(value: unknown, expected: { runId: string; revision: number }): TokyoPelekaPostalSnapshot {
  const topKeys = ['schemaVersion', 'store', 'runId', 'snapshotId', 'revision', 'businessDate', 'generatedAt',
    'buyPriceDisplayMode', 'boxBuybackEnabled', 'products', 'fingerprint'] as const;
  if (!record(value) || !exactKeys(value, topKeys)) throw new Error('Peleka郵送カタログの形式が不正です');
  const products = value.products;
  if (value.schemaVersion !== 1 || value.store !== 'manman-akihabara'
    || typeof value.runId !== 'string' || !UUID.test(value.runId)
    || typeof value.snapshotId !== 'string' || !UUID.test(value.snapshotId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.businessDate !== 'string' || !DATE.test(value.businessDate)
    || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || (value.buyPriceDisplayMode !== 'UPPER_ONLY' && value.buyPriceDisplayMode !== 'RANGE')
    || typeof value.boxBuybackEnabled !== 'boolean' || !Array.isArray(products)
    || typeof value.fingerprint !== 'string' || !FINGERPRINT.test(value.fingerprint)) {
    throw new Error('Peleka郵送カタログの形式が不正です');
  }
  if (value.runId !== expected.runId || value.revision !== expected.revision) {
    throw new Error(`Peleka郵送カタログのrun/revisionが一致しません: expected=${expected.runId}/${expected.revision}`);
  }

  const parsedProducts: TokyoPelekaPostalProduct[] = products.map((product, index) => {
    const keys = ['sourceId', 'franchise', 'productType', 'name', 'modelNumber', 'imageUrl', 'priceHigh', 'priceLow'] as const;
    if (!record(product) || !exactKeys(product, keys)
      || typeof product.sourceId !== 'string' || !product.sourceId.trim()
      || typeof product.franchise !== 'string' || !FRANCHISES.has(product.franchise)
      || (product.productType !== 'PSA10' && product.productType !== 'BOX')
      || typeof product.name !== 'string' || !product.name.trim()
      || (product.modelNumber !== null && typeof product.modelNumber !== 'string')
      || typeof product.imageUrl !== 'string' || !product.imageUrl.trim()
      || !positivePrice(product.priceHigh) || !nonnegativePrice(product.priceLow)
      || product.priceLow > product.priceHigh) {
      throw new Error(`Peleka郵送カタログ商品が不正です: index=${index}`);
    }
    return product as TokyoPelekaPostalProduct;
  });
  if (!value.boxBuybackEnabled && parsedProducts.some(product => product.productType === 'BOX')) {
    throw new Error('BOX無効のPeleka郵送カタログにBOX商品が含まれています');
  }
  if (new Set(parsedProducts.map(product => product.sourceId)).size !== parsedProducts.length) {
    throw new Error('Peleka郵送カタログにsourceId重複があります');
  }
  const snapshot = { ...value, products: parsedProducts } as TokyoPelekaPostalSnapshot;
  return snapshot;
}

export async function fetchTokyoPelekaPostalSnapshot(
  endpoint: string,
  token: string,
  expected: { runId: string; revision: number },
): Promise<TokyoPelekaPostalSnapshot> {
  const url = new URL(endpoint);
  url.searchParams.set('runId', expected.runId);
  url.searchParams.set('revision', String(expected.revision));
  const response = await fetchWithRetry(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Peleka郵送カタログ取得失敗: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  return parseTokyoPelekaPostalSnapshot(await response.json(), expected);
}

export function assertTokyoPelekaPostalUnchanged(
  initial: Pick<TokyoPelekaPostalSnapshot, 'runId' | 'revision' | 'fingerprint'>,
  confirmed: Pick<TokyoPelekaPostalSnapshot, 'runId' | 'revision' | 'fingerprint'>,
) {
  if (confirmed.runId !== initial.runId || confirmed.revision !== initial.revision
    || confirmed.fingerprint !== initial.fingerprint) {
    throw new Error('Peleka郵送カタログが画像生成中に変更されました');
  }
}

function productType(card: PreparedCardRow): 'PSA10' | 'BOX' {
  return card.tag === 'BOX' || card.grade === 'BOX' || card.grade === '未開封BOX' ? 'BOX' : 'PSA10';
}

export function matchTokyoPelekaPostalProducts(cards: PreparedCardRow[], snapshot: TokyoPelekaPostalSnapshot) {
  const cardsBySource = new Map<string, PreparedCardRow[]>();
  for (const card of cards) {
    const sourceId = card.source_shinsoku_id?.trim();
    if (!sourceId) continue;
    cardsBySource.set(sourceId, [...(cardsBySource.get(sourceId) ?? []), card]);
  }
  return snapshot.products.map(product => {
    const matches = cardsBySource.get(product.sourceId) ?? [];
    if (matches.length !== 1) throw new Error(`Peleka郵送商品を一意に照合できません: sourceId=${product.sourceId}`);
    const card = matches[0];
    if (card.franchise !== product.franchise || productType(card) !== product.productType
      || card.card_name !== product.name || (card.list_no ?? null) !== product.modelNumber) {
      throw new Error(`Peleka郵送商品のidentityが一致しません: sourceId=${product.sourceId}`);
    }
    if (!product.imageUrl.trim()) throw new Error(`Peleka郵送商品の画像がありません: sourceId=${product.sourceId}`);
    return {
      ...card,
      image_url: product.imageUrl,
      alt_image_url: null,
      price_high: product.priceHigh,
      price_low: product.priceLow,
      pelekaProduct: product,
    };
  });
}

export function pageTokyoPelekaSnapshot(
  snapshot: TokyoPelekaPostalSnapshot,
  products: TokyoPelekaPostalProduct[],
): TokyoPelekaPostalPageSnapshot {
  return { ...snapshot, products };
}
