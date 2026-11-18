import { fetchCheckerShops, parseCheckerShop, KAITORI_CHECKER_API_BASE } from '../lib/kaitori-checker-shops';
import { fetchWithRetry } from '../lib/fetch-with-retry';
import { getSecret } from '../lib/secret-manager';
import { createHmac } from 'node:crypto';

jest.mock('../lib/fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('../lib/secret-manager', () => ({ getSecret: jest.fn() }));
const box = { product_id: '21461', category_id: '1', name: 'テラスタルフェスex',
  model_number: null, condition_id: '2', edition_id: null, edition_name: null,
  buy_price: '40000.00', ask_flag: '0', price_updated_at: '2026-11-18 10:40:03', image_url: null };
const shop = (products: unknown[] = [box]) => ({ id: '11', name: 'Blue Rocket', products });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSecret).mockResolvedValue('test-secret');
  jest.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify(shop())));
});

test('fetches only each requested shop once and signs the existing API', async () => {
  const result = await fetchCheckerShops([11, 11], [2]);
  expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  const [url, init] = jest.mocked(fetchWithRetry).mock.calls[0];
  expect(url).toBe(`${KAITORI_CHECKER_API_BASE}/api/shops/11`);
  expect(init).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
  expect((init?.headers as Record<string, string>)['X-APP-SIGN']).toHaveLength(64);
  expect(result.report).toMatchObject({ shop_ids: [11], condition_ids: [2], product_count: 1, offer_count: 1 });
  expect(result.offers[0]).toMatchObject({ shop_id: 11, buy_price: 40000,
    source_updated_at: '2026-11-18T01:40:03.000Z', edition_id: 0 });
});

test('filters unrequested conditions, unsupported categories and ask-only prices', () => {
  const result = parseCheckerShop(shop([box, { ...box, condition_id: '1' },
    { ...box, condition_id: '3' }, { ...box, category_id: '99' }, { ...box, ask_flag: '1' }]), 11, [2]);
  expect(result.offers).toHaveLength(1);
  expect(result.receivedCount).toBe(5);
});

test('retains distinct editions and exact duplicates do not double a quote', () => {
  const result = parseCheckerShop(shop([box, box, { ...box, edition_id: '7', edition_name: '別版', buy_price: '30000' }]), 11, [2]);
  expect(result.products).toHaveLength(1);
  expect(result.offers.map(row => row.edition_id)).toEqual([0, 7]);
});

test.each([{}, { ...shop(), id: 3 }, { ...shop(), products: null }])('rejects wrong shops and incomplete responses', value => {
  expect(() => parseCheckerShop(value, 11, [2])).toThrow('店舗・商品一覧');
});

test.each([{ product_id: 'bad' }, { edition_id: '-1' }, { buy_price: '100.5' }, { buy_price: 'NaN' }, { buy_price: '' },
  { buy_price: true }, { buy_price: [40000] }])(
  'rejects malformed required product/price data: %j', patch => {
    expect(() => parseCheckerShop(shop([{ ...box, ...patch }]), 11, [2])).toThrow('商品・価格');
  });

test('conflicting duplicates fail rather than silently choosing a price', () => {
  expect(() => parseCheckerShop(shop([box, { ...box, buy_price: '50000' }]), 11, [2])).toThrow('価格が重複');
});

test('unavailable PSA cards with null prices do not discard a shop and variant metadata survives', () => {
  const psa = { ...box, product_id: '12984', condition_id: '1', name: 'ニンフィアGX', model_number: '057/051',
    rarity: 'SR', aspect: '中国語版', holo_type: 'マスターボールミラー' };
  const result = parseCheckerShop(shop([box, psa,
    { ...psa, product_id: '12985', buy_price: null, ask_flag: null, price_updated_at: null },
    { ...psa, product_id: '12986', buy_price: 0 }, { ...psa, product_id: '12987', buy_price: '0.00' },
    { ...psa, condition_id: '3' }]), 11, [1, 2]);
  expect(result.offers.map(row => row.condition_id)).toEqual([2, 1]);
  expect(result.products[1]).toMatchObject({ source_product_id: 12984, rarity: 'SR', aspect: '中国語版',
    holo_type: 'マスターボールミラー', model_number: '057/051' });
});

test('invalid update timestamps remain unusable and are never replaced with fetch time', () => {
  expect(parseCheckerShop(shop([{ ...box, price_updated_at: 'bad' }]), 11, [2]).offers[0].source_updated_at).toBeNull();
});

test('a confirmed empty shop can leave other sources in the comparison', () => {
  expect(parseCheckerShop(shop([]), 11, [2]).offers).toEqual([]);
});

test('all-shop API failure is explicit and authentication errors are not retried', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(new Response('{}', { status: 401 }));
  await expect(fetchCheckerShops([11], [2])).rejects.toThrow('shop=11, HTTP 401');
  expect(fetchWithRetry).toHaveBeenCalledTimes(1);
});

test('empty or invalid store configuration cannot fetch the global catalog', async () => {
  await expect(fetchCheckerShops([], [2])).rejects.toThrow('未設定');
  await expect(fetchCheckerShops([11], [])).rejects.toThrow('未設定');
  expect(fetchWithRetry).not.toHaveBeenCalled();
});

test('five requested shops are fetched once; one failed shop does not discard the others', async () => {
  jest.mocked(fetchWithRetry).mockImplementation(async url => {
    const shopId = Number(url.split('/').at(-1));
    return shopId === 44 ? new Response('{}', { status: 403 })
      : new Response(JSON.stringify({ ...shop(), id: shopId, name: `Shop ${shopId}` }));
  });
  const result = await fetchCheckerShops([55, 11, 51, 44, 54, 11], [2]);
  expect(fetchWithRetry).toHaveBeenCalledTimes(5);
  expect(result.report.shop_ids).toEqual([11, 44, 51, 54, 55]);
  expect(result.offers.map(offer => offer.shop_id)).toEqual([11, 51, 54, 55]);
  expect(result.report.shops.find(entry => entry.shop_id === 44)).toMatchObject({
    error: expect.stringContaining('HTTP 403'), offer_count: 0,
  });
  expect(result.offers[0].shop_name).toBe('Shop 11');
});

test('a wrong-shop payload is isolated rather than adopted under the requested identity', async () => {
  jest.mocked(fetchWithRetry).mockImplementation(async () => new Response(JSON.stringify(shop())));
  const result = await fetchCheckerShops([11, 51], [2]);
  expect(result.offers.map(offer => offer.shop_id)).toEqual([11]);
  expect(result.report.shops[1].error).toContain('店舗・商品一覧');
});

test('retry crossing a minute boundary recomputes the signature', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-18T01:40:59.500Z') });
  try {
    jest.mocked(fetchWithRetry).mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(shop())));
    const task = fetchCheckerShops([11], [2]);
    await jest.advanceTimersByTimeAsync(1000);
    await task;
    const signatures = jest.mocked(fetchWithRetry).mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['X-APP-SIGN']);
    expect(signatures).toHaveLength(2);
    expect(signatures[0]).not.toBe(signatures[1]);
    expect(signatures[1]).toBe(createHmac('sha256', 'test-secret')
      .update('test-secret' + Math.floor(Date.now() / 60_000).toString()).digest('hex'));
  } finally { jest.useRealTimers(); }
});
