import { normalizeStorePricingSettings, type PreparedCardRow } from '@haraka/shared';
import {
  calculateTokyoExtorecaBoxPrice, compareTokyoSourceProducts, type buildTokyoBuybackSnapshot,
  type TokyoCandidate,
} from '../jobs/tokyo-buyback-sync';
import { extorecaPsaCandidates, fetchExtorecaBoxSheet, fetchExtorecaPsaSheet, parseExtorecaSheet } from '../lib/extoreca-sheet';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import { buildTokyoBuybackSheetValues } from '../lib/buyback-sheet';
import { buildTokyoPelekaCatalog } from '../lib/peleka-catalog';

const boxCsv = `案内,この行は説明です
,商品名,レアリティ,識別番号,希望卸金額（エクス）,納品済,希望個数,残注数,希望納期,卸金額,在庫数,備考
,テラスタルフェスex,BOX,,54000,0,1,1,2026/10/31,99999,1,
,例）入力例,BOX,,60000,0,1,1,,1,1,
,空価格,BOX,,,0,1,1,,70000,1,
,ゼロ価格,BOX,,0,0,1,1,,70000,1,`;

const psaCsv = `\uFEFF商品名,レアリティ,識別番号,希望卸金額(エクス),納品済,希望個数,残注数,希望納期,卸金額,在庫数,備考
例）ピカチュウ,SAR,001/SV-P,100000,0,1,1,,200000,1,
ピカチュウ(中国語版),SAR,001/SV-P,80000,0,1,1,,90000,1,
ピカチュウ(エラー版),SAR,001/SV-P,85000,0,1,1,,95000,1,
型番なし,SAR,,70000,0,1,1,,80000,1,`;

const boxCandidate = (source: TokyoCandidate['source'], sourcePrice: number | null,
  franchise = 'Pokemon', productType: TokyoCandidate['productType'] = 'BOX', id = source): TokyoCandidate => ({
  source, id, franchise, name: '境界テスト', modelNumber: productType === 'PSA10' ? '001/001' : null,
  productType, sourcePrice,
});

describe('Extoreca CSV fetch', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['BOX', '0', fetchExtorecaBoxSheet],
    ['PSA10', '1475300317', fetchExtorecaPsaSheet],
  ] as const)('fetches %s with an explicit header row to preserve numeric-column labels', async (productType, gid, fetchSheet) => {
    const csv = '10/27,商品名,レアリティ,識別番号,希望卸金額(エクス),希望個数,残注数\n'
      + ',対象商品,SAR,001/SV-P,12000,50,2';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(csv));
    const rows = await fetchSheet();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('headers')).toBe('1');
    expect(url.searchParams.get('gid')).toBe(gid);
    expect(rows).toEqual([expect.objectContaining({
      id: `sheet:${productType.toLowerCase()}:2`, name: '対象商品', price: 12000, productType,
    })]);

    fetchMock.mockResolvedValue(new Response(csv.replace('希望卸金額(エクス)', '')));
    await expect(fetchSheet()).rejects.toThrow('ヘッダーが見つかりません');
  });
});

test('BOX uses only 希望卸金額(エクス), excludes examples and applies the existing 10% rounding', () => {
  const rows = parseExtorecaSheet(boxCsv, 'BOX');
  expect(rows).toEqual([expect.objectContaining({ name: 'テラスタルフェスex', price: 54000, productType: 'BOX' })]);
  const candidate: TokyoCandidate = { source: 'extoreca', id: rows[0].id, franchise: 'Pokemon',
    name: rows[0].name, modelNumber: null, productType: 'BOX', sourcePrice: rows[0].price };
  expect(compareTokyoSourceProducts([candidate], [], normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z')
    .products[0]).toMatchObject({ source_price: 54000, price_high: 48000, price_low: 48000,
      selected_high_source: 'extoreca', selected_low_source: 'extoreca' });
});

test('a matched Pokemon BOX uses the Extoreca margin price and keeps both raw sources', () => {
  const extoreca: TokyoCandidate = { source: 'extoreca', id: 'sheet:box:2', franchise: 'Pokemon',
    name: 'テストBOX', modelNumber: null, productType: 'BOX', sourcePrice: 100000 };
  const competitor: TokyoCandidate = { ...extoreca, source: 'blue_rocket', id: 'competitor', sourcePrice: 150000 };
  const result = compareTokyoSourceProducts([extoreca, competitor], [{ id: 'shinsoku-box', franchise: 'Pokemon',
    name: 'テストBOX', modelNumber: null, productType: 'BOX', price: 99000, imageUrl: null }],
  normalizeStorePricingSettings({ tokyo_source_discount_rates: { extoreca: { high: 0.99, low: 0.99 } } }),
  '2026-10-19T00:00:00Z');
  expect(result.products[0]).toMatchObject({ source_price: 100000, price_high: 96600, price_low: 96600,
    selected_high_source: 'extoreca', selected_low_source: 'extoreca' });
  expect(result.products[0].origins.map(origin => [origin.source, origin.rawPrice])).toEqual([
    ['blue_rocket', 150000], ['extoreca', 100000], ['shinsoku', 99000],
  ]);
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')).toMatchObject({
    highPrice: 135000,
  });
  const extorecaOrigin = result.products[0].origins.find(origin => origin.source === 'extoreca')!;
  expect(extorecaOrigin).toMatchObject({ highPrice: 96600, lowPrice: 96600 });
  expect(extorecaOrigin.highRate).toBeCloseTo(0.034);
  expect(extorecaOrigin.lowRate).toBeCloseTo(0.034);
  expect(result.priceSources['shinsoku-box']).toEqual({
    source: 'extoreca', source_id: 'sheet:box:2', price: 100000,
  });
});

test.each([
  [10000, 11499, 11100],
  [10000, 11500, 10400],
  [10000, 11501, 10400],
  [23500, 30000, 27200],
])('uses the Oripark margin boundary shinsoku=%i requested=%i', (shinsoku, requested, expected) => {
  const result = compareTokyoSourceProducts([boxCandidate('extoreca', requested)], [{
    id: 'shinsoku-boundary', franchise: 'Pokemon', name: '境界テスト', modelNumber: null,
    productType: 'BOX', price: shinsoku, imageUrl: null,
  }], normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z');
  expect(result.products[0]).toMatchObject({ price_high: expected, price_low: expected,
    selected_high_source: 'extoreca', selected_low_source: 'extoreca' });
  expect(expected % 100).toBe(0);
});

test.each([[0, 1000], [1000, 0], [99999901, 1000], [1000, 100000001]])(
  'rejects an out-of-range margin input shinsoku=%i requested=%i', (shinsoku, requested) => {
    expect(calculateTokyoExtorecaBoxPrice(shinsoku, requested)).toBeNull();
  });

test('rejects a margin result rounded to zero', () => {
  expect(calculateTokyoExtorecaBoxPrice(1000, 1)).toBeNull();
});

test('the margin formula is limited to Pokemon BOX with one usable Extoreca and Shinsoku reference', () => {
  const settings = normalizeStorePricingSettings({ tokyo_outlier_guard: { max_median_ratio: 10, max_source_price: 15000 } });
  const missing = compareTokyoSourceProducts([boxCandidate('extoreca', 11500)], [], settings, '2026-10-19T00:00:00Z');
  expect(missing.products[0]).toMatchObject({ selected_high_source: 'extoreca', price_high: 10000 });

  const invalid = compareTokyoSourceProducts([boxCandidate('extoreca', 11500)], [{
    id: 'invalid', franchise: 'Pokemon', name: '境界テスト', modelNumber: null,
    productType: 'BOX', price: 0, imageUrl: null,
  }], settings, '2026-10-19T00:00:00Z');
  expect(invalid.products[0]).toMatchObject({ selected_high_source: 'extoreca', price_high: 10000 });
  expect(invalid.unmatched.map(row => row.reason)).toContain('invalid_price');

  const ambiguous = compareTokyoSourceProducts([boxCandidate('extoreca', 11500)], [
    { id: 'a', franchise: 'Pokemon', name: '境界テスト', modelNumber: null, productType: 'BOX', price: 10000, imageUrl: null },
    { id: 'b', franchise: 'Pokemon', name: '境界テスト', modelNumber: null, productType: 'BOX', price: 10100, imageUrl: null },
  ], settings, '2026-10-19T00:00:00Z');
  expect(ambiguous.products).toEqual([]);
  expect(ambiguous.unmatched.every(row => row.reason === 'ambiguous')).toBe(true);

  const outlier = compareTokyoSourceProducts([boxCandidate('extoreca', 11500)], [{
    id: 'outlier', franchise: 'Pokemon', name: '境界テスト', modelNumber: null,
    productType: 'BOX', price: 20000, imageUrl: null,
  }], settings, '2026-10-19T00:00:00Z');
  expect(outlier.products[0]).toMatchObject({ selected_high_source: 'extoreca', price_high: 10000 });
  expect(outlier.products[0].origins.find(origin => origin.source === 'shinsoku')).toMatchObject({ excluded: true });

  for (const [franchise, productType] of [['ONE PIECE', 'BOX'], ['Pokemon', 'PSA10']] as const) {
    const result = compareTokyoSourceProducts([boxCandidate('extoreca', 11500, franchise, productType)], [{
      id: `${franchise}:${productType}`, franchise, name: '境界テスト',
      modelNumber: productType === 'PSA10' ? '001/001' : null, productType, price: 10000, imageUrl: null,
    }], normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z');
    expect(result.products[0]).toMatchObject({ selected_high_source: 'extoreca', price_high: 10000 });
  }
});

test('the margin price survives comparison, prepared cards and Tokyo sheet export', () => {
  const compared = compareTokyoSourceProducts([boxCandidate('extoreca', 11500)], [{
    id: 'shinsoku-box', franchise: 'Pokemon', name: '境界テスト', modelNumber: null,
    productType: 'BOX', price: 10000, imageUrl: 'https://example.com/box.png',
  }], normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z');
  const snapshotId = '00000000-0000-4000-8000-000000000001';
  const runId = '00000000-0000-4000-8000-000000000002';
  const result = { snapshot: { id: snapshotId, store: 'manman-akihabara', business_date: '2026-10-19' },
    products: compared.products } as unknown as Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>;
  const prepared = buildTokyoPreparedCards(runId, result);
  expect(prepared[0]).toMatchObject({ price_high: 10400, price_low: 10400 });
  const card = { ...prepared[0], id: 'prepared-box' } as any;
  const values = buildTokyoBuybackSheetValues({
    runId, snapshotId, businessDate: '2026-10-19', importId: 'import-1', orderedCardIds: [card.id],
    cards: [card], products: [{ ...compared.products[0], snapshot_id: snapshotId }], orderListItems: [],
  });
  expect(values[1][7]).toBe(10400);
  const peleka = buildTokyoPelekaCatalog({
    runId, snapshotId, businessDate: '2026-10-19', generatedAt: '2026-10-19T00:00:00Z',
    cards: [card as PreparedCardRow], pricingSources: new Map([['shinsoku-box', compared.products[0].origins.map(origin => ({
      source: origin.source, rawPrice: origin.rawPrice, baselineHighRate: origin.highRate,
      baselineHighPrice: origin.highPrice, baselineLowRate: origin.lowRate, baselineLowPrice: origin.lowPrice,
    }))]]),
  });
  expect(peleka.products[0]).toMatchObject({
    sourceId: 'shinsoku-box', priceHigh: 10400, priceLow: 10400, shinsokuPrice: 10000,
  });
  expect(compared.products[0].origins.find(origin => origin.source === 'shinsoku')).toMatchObject({ rawPrice: 10000 });
});

test('PSA may be empty after example rows, while future real variants keep exact names and require model numbers', () => {
  expect(parseExtorecaSheet(psaCsv.split('\n').slice(0, 2).join('\n'), 'PSA10')).toEqual([]);
  expect(parseExtorecaSheet(psaCsv, 'PSA10').map(row => [row.name, row.modelNumber, row.price])).toEqual([
    ['ピカチュウ(中国語版)', '001/SV-P', 80000],
    ['ピカチュウ(エラー版)', '001/SV-P', 85000],
  ]);
});

test('PSA duplicate identities with conflicting prices and model collisions fail closed', () => {
  const rows = parseExtorecaSheet(`${psaCsv}\nピカチュウ(中国語版),SAR,001/SV-P,82000,0,1,1,,1,1,`, 'PSA10');
  expect(rows.some(row => row.name.includes('中国語版'))).toBe(false);
  expect(extorecaPsaCandidates(rows, [{ franchise: 'Pokemon', name: '別名', modelNumber: '001/SV-P', productType: 'PSA10' }]))
    .toEqual({ used: [], skipped: rows.map(({ name, modelNumber, price }) => ({ name, modelNumber, price })) });
});

test('missing or ambiguous required headers fail closed', () => {
  expect(() => parseExtorecaSheet('商品名,識別番号\nカード,001/SV-P', 'PSA10')).toThrow('ヘッダーが見つかりません');
  expect(() => parseExtorecaSheet(
    '商品名,レアリティ,識別番号,希望卸金額(エクス),希望卸金額（エクス）\nカード,SAR,001/SV-P,1,2', 'PSA10'))
    .toThrow('「希望卸金額(エクス)」列が曖昧です');
});
