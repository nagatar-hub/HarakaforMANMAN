import {
  assertTokyoPelekaPostalUnchanged,
  fetchTokyoPelekaPostalSnapshot,
  matchTokyoPelekaPostalProducts,
  parseTokyoPelekaPostalSnapshot,
} from '../lib/peleka-postal';
import { assertExactTokyoPelekaPostalCoverage } from '../lib/tokyo-peleka-postal-render';

const runId = '10000000-0000-4000-8000-000000000001';
const snapshotId = '20000000-0000-4000-8000-000000000001';
const product = {
  sourceId: 'source-1', franchise: 'Pokemon', productType: 'PSA10' as const, name: 'ピカチュウ',
  modelNumber: '001/100', imageUrl: 'https://example.invalid/postal.png', priceHigh: 12300, priceLow: 9800,
};
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, store: 'manman-akihabara', runId, snapshotId, revision: 7,
  businessDate: '2026-10-06', generatedAt: '2026-10-06T01:00:00.000Z',
  buyPriceDisplayMode: 'RANGE', boxBuybackEnabled: false, products: [product], fingerprint: 'a'.repeat(32),
  ...overrides,
});

test('GET uses the existing bearer token and exact run/revision query, accepting zero eligible products', async () => {
  const originalFetch = global.fetch;
  const response = snapshot({ products: [] });
  global.fetch = jest.fn(async () => new Response(JSON.stringify(response), { status: 200,
    headers: { 'Content-Type': 'application/json' } }));
  try {
    await expect(fetchTokyoPelekaPostalSnapshot('https://example.invalid/catalog?keep=1', 'secret', { runId, revision: 7 }))
      .resolves.toEqual(response);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(new URL(url).searchParams.get('runId')).toBe(runId);
    expect(new URL(url).searchParams.get('revision')).toBe('7');
    expect(new URL(url).searchParams.get('keep')).toBe('1');
    expect(init.headers.Authorization).toBe('Bearer secret');
  } finally { global.fetch = originalFetch; }
});

test('strictly rejects schema drift, stale identity, BOX leakage, and receiver errors', async () => {
  expect(() => parseTokyoPelekaPostalSnapshot({ ...snapshot(), extra: true }, { runId, revision: 7 })).toThrow('形式が不正');
  expect(() => parseTokyoPelekaPostalSnapshot(snapshot(), { runId, revision: 8 })).toThrow('run/revision');
  expect(() => parseTokyoPelekaPostalSnapshot(snapshot({ products: [{ ...product, productType: 'BOX' }] }),
    { runId, revision: 7 })).toThrow('BOX無効');
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response('stale', { status: 409 }));
  try {
    await expect(fetchTokyoPelekaPostalSnapshot('https://example.invalid/catalog', 'secret', { runId, revision: 7 }))
      .rejects.toThrow('HTTP 409 stale');
  } finally { global.fetch = originalFetch; }
});

test('maps exact source identity once and overlays only Peleka image/prices', () => {
  const card = { id: 'card-1', run_id: runId, source_shinsoku_id: 'source-1', franchise: 'Pokemon',
    card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001/100', tag: 'PSA10', image_url: 'https://store.invalid/card.png',
    alt_image_url: null, price_high: 10000, price_low: 8000 } as any;
  expect(matchTokyoPelekaPostalProducts([card], snapshot() as any)[0]).toMatchObject({
    id: 'card-1', image_url: product.imageUrl, price_high: 12300, price_low: 9800,
  });
  expect(card).toMatchObject({ image_url: 'https://store.invalid/card.png', price_high: 10000, price_low: 8000 });
  expect(() => matchTokyoPelekaPostalProducts([], snapshot() as any)).toThrow('一意に照合');
  expect(() => matchTokyoPelekaPostalProducts([{ ...card, card_name: '別名' }], snapshot() as any)).toThrow('identity');
});

test('fingerprint changes prevent success', () => {
  expect(() => assertTokyoPelekaPostalUnchanged(snapshot() as any, snapshot({ fingerprint: 'b'.repeat(32) }) as any))
    .toThrow('画像生成中に変更');
  expect(() => assertTokyoPelekaPostalUnchanged(snapshot() as any, snapshot() as any)).not.toThrow();
});

test('postal planning must cover every eligible product exactly once', () => {
  expect(() => assertExactTokyoPelekaPostalCoverage(['a', 'b'], [{ label: 'x', cardIds: ['a', 'b'], layoutTemplateId: 'l' }])).not.toThrow();
  expect(() => assertExactTokyoPelekaPostalCoverage(['a', 'b'], [{ label: 'x', cardIds: ['a', 'a'], layoutTemplateId: 'l' }]))
    .toThrow('全商品を一意');
  expect(() => assertExactTokyoPelekaPostalCoverage(['a', 'b'], [{ label: 'x', cardIds: ['a'], layoutTemplateId: 'l' }]))
    .toThrow('全商品を一意');
});
