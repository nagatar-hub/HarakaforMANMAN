import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync';
import { assertOriparkCoverage, completeOriparkCoverage, coverageMatches, loadOriparkCoverage, type CoverageCard } from '../lib/oripark-coverage';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

const settings = normalizeStorePricingSettings({});
const card: CoverageCard = { id: 'ori-1', franchise: 'Pokemon', card_name: 'カイ', grade: 'PSA10',
  list_no: '236/172', tag: 'サポート', rarity: 'SAR', image_url: 'https://example.com/kai.png', alt_image_url: null,
  excel_product_id: 'excel-1', source: 'order_list', raw_import: { source_price: 120000, price_source: 'order_list' } };
const baseline = (cards = [card]) => ({ runId: 'oripark-run', businessDate: '2026-11-16', fingerprint: 'fingerprint', cards });
const compare = (rows: any[] = []) => compareTokyoSourceProducts(rows, [], settings, '2026-11-16T02:00:00Z');

test('omitted Excel products use the original price and Tokyo rates, with published image fallback', () => {
  const result = compare();
  const report = completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]));
  expect(result.products[0]).toMatchObject({ source_price: 120000, selected_high_source: 'kecak' });
  expect(result.products[0].price_high).toBe(compare([{ source: 'kecak', id: 'x', franchise: 'Pokemon',
    name: 'カイ', modelNumber: '236/172', productType: 'PSA10', sourcePrice: 120000 }]).products[0].price_high);
  const prepared = buildTokyoPreparedCards('tokyo-run', { products: result.products,
    snapshot: { store: 'manman-akihabara', business_date: '2026-11-16', report: { oripark_coverage: report } } } as any);
  expect(prepared[0]).toMatchObject({ image_url: card.image_url, tag: 'サポート', rarity: 'SAR', db_card_id: null });
  expect(() => assertOriparkCoverage(report, prepared as any)).not.toThrow();
  expect(() => assertOriparkCoverage(report, [])).toThrow('欠落');
});

test('current Tokyo source price wins and an Oripark price never overwrites it', () => {
  const result = compare([{ source: 'kecak', id: 'excel-1', franchise: 'Pokemon', name: 'カイ',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]);
  const before = JSON.stringify(result.products);
  completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]));
  expect(JSON.stringify(result.products)).toBe(before);
});

test('unopened sets already published by Oripark are included without broadening to all unopened items', () => {
  const box = { ...card, card_name: 'ポケモン切手BOX', grade: 'BOX', tag: 'BOX', list_no: null,
    source: 'shinsoku', raw_import: { source_price: 300000, price_source: 'shinsoku' } };
  const result = compare();
  completeOriparkCoverage(result, baseline([box]), '2026-11-16', 1, c => compare([c]));
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ product_type: 'box', name: 'ポケモン切手BOX', selected_high_source: 'shinsoku' });
});

test('expired original prices and zero/invalid original prices cannot silently fill coverage', () => {
  expect(() => completeOriparkCoverage(compare(), baseline(), '2026-11-18', 1, c => compare([c]))).toThrow('鮮度');
  expect(() => completeOriparkCoverage(compare(), baseline([{ ...card, raw_import: { source_price: 0, price_source: 'order_list' } }]),
    '2026-11-16', 1, c => compare([c]))).toThrow('補完できません');
});

test('same model numbers do not collapse different card variants or franchises', () => {
  const product = compare([{ source: 'shinsoku', id: 'variant', franchise: 'Pokemon', name: 'カイ(エラー版)',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]).products[0];
  expect(coverageMatches(card, product)).toBe(false);
  expect(coverageMatches({ ...card, franchise: 'ONE PIECE' }, product)).toBe(false);
});

test('ambiguous identities fail instead of selecting an arbitrary Tokyo product', () => {
  const result = compare([{ source: 'shinsoku', id: 'a', franchise: 'Pokemon', name: 'カイ',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]);
  result.products.push({ ...result.products[0], id: 'b' });
  expect(() => completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]))).toThrow('複数商品');
});

test('supplemented overridden BOX prices use Shinsoku rates and provenance, not order-list rates', () => {
  const custom = normalizeStorePricingSettings({});
  custom.tokyo_source_discount_rates.kecak = { high: 0.1, low: 0.2 };
  custom.tokyo_source_discount_rates.shinsoku = { high: 0.3, low: 0.4 };
  const compareBox = (rows: any[] = []) => compareTokyoSourceProducts(rows, [], custom, '2026-11-16T02:00:00Z');
  const box: CoverageCard = { ...card, card_name: 'テストBOX', tag: 'BOX', grade: 'BOX', list_no: null,
    raw_import: { source_price: 10000, price_source: 'order_list', raw_row: {
      pokemon_box_price_source: 'BOX_PRICE_DB', pokemon_box_original_order_list_price: 20000,
    } } };
  const result = compareBox();
  completeOriparkCoverage(result, baseline([box]), '2026-11-16', 1, c => compareBox([c]));
  const expected = compareBox([{ source: 'shinsoku', id: box.excel_product_id, franchise: box.franchise,
    name: box.card_name, modelNumber: null, productType: 'BOX', sourcePrice: 10000 }]).products[0];
  expect(result.products[0]).toMatchObject({ source_price: 10000, selected_high_source: 'shinsoku',
    selected_low_source: 'shinsoku', price_high: expected.price_high, price_low: expected.price_low });
  expect(result.products[0].origins[0]).toMatchObject({ source: 'shinsoku', rawPrice: 10000, highRate: 0.3, lowRate: 0.4 });
  const ordinary = { ...box, raw_import: { source_price: 10000, price_source: 'order_list', raw_row: null } };
  const ordinaryResult = compareBox();
  completeOriparkCoverage(ordinaryResult, baseline([ordinary]), '2026-11-16', 1, c => compareBox([c]));
  expect(ordinaryResult.products[0].selected_high_source).toBe('kecak');
  expect(ordinaryResult.products[0].price_high).not.toBe(result.products[0].price_high);
});

test.each(['missing', 'unrecognized'])('BOX override %s cannot silently use the KECAK rate', marker => {
  const box: CoverageCard = { ...card, tag: 'BOX', grade: 'BOX', list_no: null,
    raw_import: { source_price: 10000, price_source: 'order_list', raw_row: { pokemon_box_price_source: marker } } };
  expect(() => completeOriparkCoverage(compare(), baseline([box]), '2026-11-16', 1, c => compare([c])))
    .toThrow('元価格を特定できません');
});


test('published coverage loads and fingerprints price override metadata', async () => {
  const raw = { source_price: 10000, price_source: 'order_list', raw_row: { pokemon_box_price_source: 'BOX_PRICE_DB' } };
  const published = { ...card, raw_import: raw };
  const select = jest.fn();
  const db = { from: (table: string) => {
    const query: any = {};
    for (const method of ['eq', 'not', 'order', 'limit']) query[method] = () => query;
    query.select = (columns: string) => { select(table, columns); return query; };
    query.maybeSingle = async () => ({ data: { id: 'ori-run', order_list_import_id: 'order' } });
    query.single = async () => ({ data: { business_date: '2026-11-16' } });
    query.range = async () => ({ data: table === 'generated_page'
      ? [{ status: 'generated', kind: 'store', card_ids: [card.id] }] : [published] });
    return query;
  } };
  const first = await loadOriparkCoverage(db as any);
  expect(select).toHaveBeenCalledWith('prepared_card', expect.stringContaining('raw_import(source_price,price_source,raw_row)'));
  expect(first.cards[0].raw_import?.raw_row).toEqual(raw.raw_row);
  raw.raw_row.pokemon_box_price_source = 'missing';
  const changed = await loadOriparkCoverage(db as any);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});
