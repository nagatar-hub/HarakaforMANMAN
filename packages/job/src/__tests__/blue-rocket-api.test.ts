import {
  BLUE_ROCKET_PRICES_API_URL, blueRocketPsaCandidates, fetchBlueRocketPsaPrices, parseBlueRocketPsaPrices,
} from '../lib/blue-rocket';
import { fetchWithRetry } from '../lib/fetch-with-retry';

jest.mock('../lib/fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));

// 実APIと同じ構造。kind/gradeLabel が null でも、商品名に PSA10 が付く。
const item = (overrides: Record<string, unknown> = {}) => ({
  productId: 37489, name: 'PSA10 MカメックスEX [20th 074/072](ポケットモンスターカードゲーム)',
  cardNumber: '074/072', price: 24000, imageUrl: 'https://cdn.example/card.webp',
  kind: null, gradeLabel: null, remainingQty: 1, receivedQty: 0, status: 'available',
  ...overrides,
});
const payload = (items: unknown[] = [item()], overrides: Record<string, unknown> = {}) => ({
  storeId: 'laox', storeCode: 'laox', storeName: 'ラオックス店', businessDate: '2026-10-20',
  fetchedAt: '2026-10-20T03:25:20.833Z', items, ...overrides,
});

beforeEach(() => jest.mocked(fetchWithRetry).mockReset());

test('reads the live API shape and retains its business date and stable product id', () => {
  expect(parseBlueRocketPsaPrices(payload())).toEqual({
    storeId: 'laox', businessDate: '2026-10-20', fetchedAt: '2026-10-20T03:25:20.833Z', itemCount: 1,
    rows: [{ id: 'api:laox:37489', name: 'MカメックスEX', modelNumber: '074/072',
      price: 24000, imageUrl: 'https://cdn.example/card.webp' }],
  });
});

test('handles PSA10 prefixes with full-width or missing spaces and an explicit grade label', () => {
  for (const name of ['PSA10　メガラティアスex SR [M1S 079/063]', 'PSA10メガラティアスex SR [M1S 079/063]']) {
    expect(parseBlueRocketPsaPrices(payload([item({ name, cardNumber: '079/063' })])).rows[0].name)
      .toBe('メガラティアスex');
  }
  expect(parseBlueRocketPsaPrices(payload([item({
    name: 'MカメックスEX [20th 074/072]', kind: 'graded', gradeLabel: 'PSA 10',
  })])).rows).toHaveLength(1);
});

test.each([
  { name: 'MカメックスEX [20th 074/072]' },
  { name: 'PSA9 MカメックスEX [20th 074/072]' },
  { name: 'PSA100 MカメックスEX [20th 074/072]' },
  { name: 'PSA9 MカメックスEX [20th 074/072]', gradeLabel: 'PSA10' },
  { gradeLabel: 'PSA9' }, { kind: 'box' }, { kind: 'single' },
  { name: 'PSA10 ロロノア・ゾロ パラレル OP06-118', cardNumber: 'OP06-118' },
  { name: 'PSA10　トラファルガー・ロー(CS/illust:Nijihayashi)　ST003/008', cardNumber: '003/008' },
  { name: 'PSA10 ワンピース テスト', cardNumber: '001/100' },
  { name: 'PSA10 モンキー・D・ルフィ モスバーガー', cardNumber: 'P-080' },
  { status: 'paused' }, { status: 'closed' }, { status: 'unknown' },
  { remainingQty: 0 }, { remainingQty: -1 }, { remainingQty: '1' }, { remainingQty: undefined },
  { price: null }, { price: 0 }, { price: -1 }, { price: 1.5 }, { price: '24000' }, { price: 100_000_001 },
  { productId: null }, { productId: '37489' }, { productId: 0 },
  { name: null }, { cardNumber: null }, { cardNumber: '085' },
])('does not import an ineligible or incomplete API row: %j', overrides => {
  expect(parseBlueRocketPsaPrices(payload([item(overrides)])).rows).toEqual([]);
});

test('accepts unlimited quantity and ignores invalid image URLs', () => {
  expect(parseBlueRocketPsaPrices(payload([item({ remainingQty: null, imageUrl: 'javascript:alert(1)' })])).rows)
    .toEqual([expect.objectContaining({ price: 24000, imageUrl: null })]);
});

test('deduplicates by card identity regardless of API ordering while preserving the best price', () => {
  const rows = [item({ productId: 1, price: 20000 }), item({ productId: 2, price: 24000 })];
  const first = parseBlueRocketPsaPrices(payload(rows)).rows;
  expect(first).toEqual(parseBlueRocketPsaPrices(payload([...rows].reverse())).rows);
  expect(first).toEqual([expect.objectContaining({ id: 'api:laox:2', price: 24000 })]);
});

test('keeps 1ED and master-ball variants separate from the ordinary card', () => {
  const rows = parseBlueRocketPsaPrices(payload([
    item({ productId: 1, name: 'PSA10 ニンフィアEX RR :1ED [CP3 025/032]', cardNumber: '025/032' }),
    item({ productId: 2, name: 'PSA10 エーフィ :マスターボールミラー [SV8a 062/187]', cardNumber: '062/187' }),
  ])).rows;
  expect(rows.map(row => row.name)).toEqual(['ニンフィアEX(1ED)', 'エーフィ(マスターボールミラー)']);
  expect(blueRocketPsaCandidates(rows, [
    { franchise: 'Pokemon', name: 'ニンフィアEX', modelNumber: '025/032', productType: 'PSA10' },
    { franchise: 'Pokemon', name: 'エーフィ', modelNumber: '062/187', productType: 'PSA10' },
  ]).used).toEqual([]);
});

test.each([
  { storeId: 'other' }, { storeCode: 'other' }, { storeId: undefined },
  { businessDate: '2026-02-30' }, { businessDate: 'invalid' }, { businessDate: null },
  { fetchedAt: 'invalid' }, { fetchedAt: '2026-10-20T12:00:00' }, { items: null }, { items: {} },
])('rejects a different store or an invalid response contract: %j', overrides => {
  expect(() => parseBlueRocketPsaPrices(payload([], overrides))).toThrow('店舗・営業日・データ形式');
});

test('an empty current catalog is a valid result with no fallback to old sheet prices', () => {
  expect(parseBlueRocketPsaPrices(payload([]))).toMatchObject({ rows: [], itemCount: 0 });
});

test('fetches only the public Laox JSON API without credentials', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify(payload())));
  await expect(fetchBlueRocketPsaPrices()).resolves.toMatchObject({
    storeId: 'laox', businessDate: '2026-10-20', rows: [expect.objectContaining({ price: 24000 })],
  });
  expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  expect(fetchWithRetry).toHaveBeenCalledWith(BLUE_ROCKET_PRICES_API_URL, {
    method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  }, { timeoutMs: 10_000, maxRetries: 1, baseDelayMs: 500 });
});

test.each([401, 503])('reports an HTTP %i error without falling back to the sheet', async status => {
  jest.mocked(fetchWithRetry).mockResolvedValue(new Response('unavailable', { status }));
  await expect(fetchBlueRocketPsaPrices()).rejects.toThrow(`HTTP ${status}`);
  expect(fetchWithRetry).toHaveBeenCalledTimes(1);
});

test('rejects an HTML response instead of silently publishing an empty catalog', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(new Response('<html>maintenance</html>'));
  await expect(fetchBlueRocketPsaPrices()).rejects.toThrow();
});
