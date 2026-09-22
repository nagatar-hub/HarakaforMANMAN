import { normalizeStorePricingSettings, validateTokyoSourceDiscountRates, type PreparedCardRow } from '@haraka/shared';
import { compareTokyoSourceProducts, tokyoProductCandidates, type buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import { buildTokyoPelekaCatalog } from '../lib/peleka-catalog';

test('the five-source comparison flows through one high/low pick into the unchanged Peleka payload', () => {
  const settings = normalizeStorePricingSettings({ tokyo_source_discount_rates: {
    kecak: { high: 0.05, low: 0.15 }, blue_rocket: { high: 0.10, low: 0.15 },
    toreca_bank: { high: 0.10, low: 0.15 }, avirile: { high: 0.10, low: 0.15 },
    shinsoku: { high: 0.05, low: 0.15 } } });
  expect(validateTokyoSourceDiscountRates(settings.tokyo_source_discount_rates)).toBeNull();

  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'DRAGON BALL', card_name: '孫悟空', list_no: 'FB03-064', grade: 'PSA10', match_status: 'matched', source_price: 50000, db_card_id: 'db1' },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '[1BOX]テスト', list_no: null, grade: 'BOX', match_status: 'matched', source_price: 10000 },
  ], [], []);
  candidates.push(
    { ...candidates[0], source: 'toreca_bank', id: 'bank-db', sourcePrice: 50000 },
    { ...candidates[1], source: 'toreca_bank', id: 'bank-box', sourcePrice: 10000 },
  );
  const compared = compareTokyoSourceProducts(candidates, [
    { id: 'IADB1', franchise: 'DRAGON BALL', name: '孫悟空', modelNumber: 'FB03-064', productType: 'PSA10', price: 60000, imageUrl: 'https://example.com/goku.png' },
    { id: 'IAP1', franchise: 'Pokemon', name: 'テスト', modelNumber: null, productType: 'BOX', price: 12000, imageUrl: 'https://example.com/box.png' },
  ], settings, '2026-09-09T05:00:00.000Z');

  // Shinsoku wins both high and low here; KECAK and the bank still competed on their own rates.
  expect(compared.products.map(product => [product.id, product.price_high, product.price_low,
    product.selected_high_source, product.selected_low_source])).toEqual([
    ['IADB1', 57000, 51000, 'shinsoku', 'shinsoku'],
    ['IAP1', 11000, 10000, 'shinsoku', 'shinsoku'],
  ]);
  expect(compared.products[0].origins.map(origin => [origin.source, origin.highPrice, origin.lowPrice])).toEqual([
    ['kecak', 47000, 42000], ['toreca_bank', 45000, 42000], ['shinsoku', 57000, 51000],
  ]);
  expect(compared.priceSources).toEqual({
    IADB1: { source: 'shinsoku', source_id: 'IADB1', price: 60000 },
    IAP1: { source: 'shinsoku', source_id: 'IAP1', price: 12000 },
  });

  const result = { snapshot: { id: '00000000-0000-4000-8000-000000000001', store: 'manman-akihabara',
    business_date: '2026-09-09', settings }, products: compared.products,
  } as unknown as Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>;
  const prepared = buildTokyoPreparedCards('00000000-0000-4000-8000-000000000002', result, [], [
    { id: 'db1', store: 'manman-akihabara', franchise: 'DRAGON BALL', card_name: '孫悟空', grade: 'PSA10',
      list_no: 'FB03-064', tag: 'TOP', image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/goku.png', alt_image_url: null, image_status: 'ok' } as any,
  ]);
  expect(prepared.find(p => p.source_shinsoku_id === 'IADB1')).toMatchObject({ price_high: 57000, price_low: 51000, tag: 'TOP', image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/goku.png' });
  expect(prepared.find(p => p.source_shinsoku_id === 'IAP1')).toMatchObject({ price_high: 11000, price_low: 10000, tag: 'BOX' });

  const payload = buildTokyoPelekaCatalog({ runId: '00000000-0000-4000-8000-000000000002', snapshotId: result.snapshot.id,
    businessDate: '2026-09-09', generatedAt: '2026-09-09T05:00:00Z', cards: prepared as PreparedCardRow[] });
  expect(payload.products.map(p => [p.sourceId, p.priceHigh, p.priceLow])).toEqual([
    ['IADB1', 57000, 51000], ['IAP1', 11000, 10000],
  ]);
});
