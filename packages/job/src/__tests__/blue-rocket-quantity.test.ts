import { postalProductIdentity } from '@haraka/shared';
import { parseBlueRocketQuantityQuotes, fetchBlueRocketQuantityQuotes, blueRocketSingleQuantityKeys } from '../lib/blue-rocket-quantity';
import { fetchWithRetry } from '../lib/fetch-with-retry';
import { filterSingleQuantityBlueRocketOffers, tokyoProductCandidates } from '../jobs/tokyo-buyback-sync';

jest.mock('../lib/fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
const day = '2026-11-19';
const item = (patch: Record<string, unknown> = {}) => ({ productId: 1, name: 'PSA10 カイ SAR [s12a 236/172]',
  cardNumber: '236/172', price: 150000, status: 'available', remainingQty: 1, boost: null,
  kind: null, gradeLabel: null, genre: 'pokemon', ...patch });
const payload = (items: unknown[] = [item()], patch: Record<string, unknown> = {}) => ({
  storeId: 'akihabara', storeCode: 'akihabara', businessDate: day, items, ...patch });
const parse = (items: unknown[]) => parseBlueRocketQuantityQuotes(payload(items), 11, 'akihabara', day, 1);
const product = { source_product_id: 7, name: 'カイ', category: 'pokemon', model_number: '236/172', full_name: null };
const offer = (shop_id: number, buy_price = 150000) => ({ source_product_id: 7, shop_id, shop_name: `Shop ${shop_id}`,
  condition_id: 1, edition_id: 0, buy_price, source_updated_at: '2026-11-19T01:00:00Z' });

beforeEach(() => jest.mocked(fetchWithRetry).mockReset());

test.each([{ remainingQty: 1 }, { remainingQty: 16, boost: { remainingQty: 1 }, normalPrice: 145000 }])(
  'a one-card Showa-dori quote is excluded without using another branch: %j', patch => {
    const quotes = parse([item(patch)]);
    const filtered = filterSingleQuantityBlueRocketOffers([product], [offer(11), offer(51, 140000)], quotes);
    expect(filtered.excluded).toMatchObject([{ shop_id: 11 }]);
    expect(tokyoProductCandidates([], [product], filtered.offers)).toEqual([]);
  });

test('one-card quotes from the referenced branch leave no Blue Rocket PSA candidate', () => {
  const quotes = parse([item()]);
  const filtered = filterSingleQuantityBlueRocketOffers([product], [offer(11), offer(51)],
    [...quotes, ...quotes.map(quote => ({ ...quote, shopId: 51 }))]);
  expect(tokyoProductCandidates([], [product], filtered.offers)).toEqual([]);
  expect(filtered.excluded).toHaveLength(1);
});

test.each([null, 2, 100])('quantity %s remains eligible and BOX is unaffected by any quantity', remainingQty => {
  const eligible = filterSingleQuantityBlueRocketOffers([product], [offer(11)], parse([item({ remainingQty })]));
  expect(eligible.offers).toHaveLength(1);
  const box = { ...offer(11), condition_id: 2 };
  expect(filterSingleQuantityBlueRocketOffers([product], [box], parse([item()])).offers).toEqual([box]);
});

test('different price, branch, model, franchise, or base card name cannot borrow a quantity restriction', () => {
  const variants = [product, { ...product, source_product_id: 8, category: 'one_piece' },
    { ...product, source_product_id: 9, model_number: '999/999' }, { ...product, source_product_id: 10, name: '別のカード' }];
  const offers = [offer(11, 140000), offer(44), { ...offer(11), source_product_id: 8 },
    { ...offer(11), source_product_id: 9 }, { ...offer(11), source_product_id: 10 }];
  expect(filterSingleQuantityBlueRocketOffers(variants, offers, parse([item()])).offers).toEqual(offers);
});

test('all matching model/price rows limited to one card exclude unknown designs and nonzero editions', () => {
  const variant = { ...product, aspect: '中国語版' };
  const limited = { ...offer(11), edition_id: 2, edition_name: '1ED' };
  expect(filterSingleQuantityBlueRocketOffers([variant], [limited], parse([item()])).offers).toEqual([]);
});

test('a multi-card model/price row blocks fallback while an exact one-card match still takes priority', () => {
  const variants = [product, { ...product, source_product_id: 8, aspect: '別柄' }];
  const offers = [offer(11), { ...offer(11), source_product_id: 8 }];
  const quotes = parse([item(), item({ productId: 2, name: 'PSA10 カイ(中国語版) SAR [s12a 236/172]', remainingQty: 2 })]);
  const filtered = filterSingleQuantityBlueRocketOffers(variants, offers, quotes);
  expect(filtered.offers).toEqual([offers[1]]);
  expect(filtered.excluded).toMatchObject([{ source_product_id: 7, quantity_exclusion_reason: 'single_quantity' }]);
});

test('an unavailable quantity API excludes Showa-dori PSA while BOX remains and other branches never enter candidates', () => {
  const offers = [offer(11), offer(44), offer(51), { ...offer(11), condition_id: 2 }];
  const filtered = filterSingleQuantityBlueRocketOffers([product], offers, [], [11]);
  expect(filtered.offers).toEqual(offers.slice(1));
  expect(filtered.excluded).toMatchObject([{ shop_id: 11, quantity_exclusion_reason: 'quantity_api_unavailable' }]);
  expect(tokyoProductCandidates([], [product], filtered.offers)).toMatchObject([{ productType: 'BOX', shopId: 11 }]);
});

test('conflicting public quotes at the same exact price do not exclude a multi-card offer', () => {
  expect(blueRocketSingleQuantityKeys(parse([item(), item({ productId: 2, remainingQty: 2 })])).size).toBe(0);
});

test('known language and holo variants remain part of the quote identity', () => {
  const quotes = parse([item({ name: 'PSA10 カイ【中国語版】 SAR [s12a 236/172]' }),
    item({ productId: 2, name: 'PSA10 エーフィ :マスターボールミラー [SV8a 062/187]', cardNumber: '062/187' })]);
  expect(quotes[1].identity).toBe(postalProductIdentity({ franchise: 'Pokemon', name: 'エーフィ(マスターボールミラー)',
    modelNumber: '062/187', productType: 'PSA10' }));
  expect(quotes[0].identity).not.toBe(parse([item()])[0].identity);
});

test('explicit ONE PIECE manga design keeps exact evidence and another design supplies model evidence', () => {
  const quotes = parse([item({ genre: 'onepiece', name: 'PSA10 エドワード・ニューゲート SR-SP (コミパラ) [OP17-005]',
    cardNumber: 'OP17-005' }), item({ genre: 'onepiece', name: 'PSA10 エネル SR-SPC [OP05-100]', cardNumber: 'OP05-100' })]);
  expect(quotes).toHaveLength(2);
  expect(quotes[0].identity).toBe(postalProductIdentity({ franchise: 'ONE PIECE', name: 'エドワード・ニューゲート(パラレル/漫画背景/漫画絵)',
    modelNumber: 'OP17-005', productType: 'PSA10' }));
  expect(quotes[1]).toMatchObject({ identity: null, modelKey: expect.any(String), singleQuantity: true });
});

test('custom ONE PIECE rows with negative product IDs and no genre supply model evidence', () => {
  const quotes = parse([item({ productId: -676064, genre: null, name: 'PSA10 トップマン・ウォーキュリー SR-SP [OP13-089]',
    cardNumber: 'OP13-089', price: 39000 })]);
  const checkerProduct = { ...product, category: 'one_piece', name: 'トップマン・ウォーキュリー', model_number: 'OP13-089',
    aspect: 'パラレル' };
  expect(quotes).toHaveLength(1);
  expect(filterSingleQuantityBlueRocketOffers([checkerProduct], [offer(11, 39000)], quotes).offers).toEqual([]);
});

test.each([{ remainingQty: '1' }, { remainingQty: undefined }, { remainingQty: 0 }, { remainingQty: -1 },
  { gradeLabel: 'PSA9' }, { name: 'PSA9 カイ SAR [s12a 236/172]' }, { kind: 'box' }, { status: 'paused' }])(
  'invalid or unrelated rows cannot add quantity evidence: %j', patch => {
    expect(parse([item(patch)])).toEqual([]);
  });

test.each([{ storeId: 'laox' }, { businessDate: '2026-11-17' }, { businessDate: '2026-11-20' }, { businessDate: 'invalid' }])(
  'wrong-store or out-of-window quantity responses are rejected: %j', patch => {
    expect(() => parseBlueRocketQuantityQuotes(payload([item()], patch), 11, 'akihabara', day, 1)).toThrow();
  });

test.each([null, 503])('only the Showa-dori quantity API is fetched and failure %s is reported', async status => {
  jest.mocked(fetchWithRetry).mockImplementation(async url => {
    const code = new URL(url).searchParams.get('store');
    return status ? new Response('{}', { status })
      : new Response(JSON.stringify(payload([item()], { storeId: code, storeCode: code })));
  });
  const result = await fetchBlueRocketQuantityQuotes(day, 1);
  expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  expect(jest.mocked(fetchWithRetry).mock.calls[0][0]).toBe('https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=akihabara');
  expect(result.quotes.map(quote => quote.shopId)).toEqual(status ? [] : [11]);
  expect(result.report.quantity_unavailable_shop_ids).toEqual([]);
  expect(result.report.shops).toMatchObject([{ shop_id: 11, error: status ? 'HTTP 503' : null }]);
});
