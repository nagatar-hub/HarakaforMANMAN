import { normalizeStorePricingSettings, type PreparedCardRow } from '@haraka/shared';
import { tokyoProductCandidates, tokyoMatchPostalProducts, tokyoDisplayPrice } from '../jobs/tokyo-buyback-sync';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import { buildTokyoPelekaCatalog } from '../lib/peleka-catalog';

test('Shinsoku postal prices flow through one high/low discount into the unchanged Peleka payload', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'DRAGON BALL', card_name: '孫悟空', list_no: 'FB03-064', grade: 'PSA10', match_status: 'matched', source_price: 50000, db_card_id: 'db1' },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '[1BOX]テスト', list_no: null, grade: 'BOX', match_status: 'matched', source_price: 10000 },
  ], [], []);
  candidates.push(
    { ...candidates[0], source: 'toreca_bank', id: 'bank-db', sourcePrice: 50000 },
    { ...candidates[1], source: 'toreca_bank', id: 'bank-box', sourcePrice: 10000 },
  );
  const match = tokyoMatchPostalProducts(candidates, [
    { id: 'IADB1', franchise: 'DRAGON BALL', name: '孫悟空', modelNumber: 'FB03-064', productType: 'PSA10', price: 60000, imageUrl: 'https://example.com/goku.png' },
    { id: 'IAP1', franchise: 'Pokemon', name: 'テスト', modelNumber: null, productType: 'BOX', price: 12000, imageUrl: 'https://example.com/box.png' },
  ]);
  const settings = normalizeStorePricingSettings({ psa10_discount_rates: { 'DRAGON BALL': 0.04 },
    box_discount_rates: { Pokemon: { shrink: 0.04, no_shrink: 0.15 } } });
  const result: any = { snapshot: { id: '00000000-0000-4000-8000-000000000001', store: 'manman-akihabara', business_date: '2026-09-09', settings },
    products: match.matched.map(({ product, sources }) => ({ id: product.id, franchise: product.franchise,
      product_type: product.productType === 'BOX' ? 'box' : 'psa', name: product.name, model_number: product.modelNumber,
      image_url: product.imageUrl, source_price: product.price,
      price_high: tokyoDisplayPrice(product.price!, product.franchise as any, product.productType, settings), origins: sources })) };
  const prepared = buildTokyoPreparedCards('00000000-0000-4000-8000-000000000002', result, [], [
    { id: 'db1', store: 'manman-akihabara', franchise: 'DRAGON BALL', card_name: '孫悟空', grade: 'PSA10',
      list_no: 'FB03-064', tag: 'TOP', image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/goku.png', alt_image_url: null, image_status: 'ok' } as any,
  ]);
  expect(prepared.find(p => p.source_shinsoku_id === 'IADB1')).toMatchObject({ price_high: 57000, price_low: 57000, tag: 'TOP', image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/goku.png' });
  expect(prepared.find(p => p.source_shinsoku_id === 'IAP1')).toMatchObject({ price_high: 11000, price_low: 10000, tag: 'BOX' });
  const payload = buildTokyoPelekaCatalog({ runId: '00000000-0000-4000-8000-000000000002', snapshotId: result.snapshot.id,
    businessDate: '2026-09-09', generatedAt: '2026-09-09T05:00:00Z', cards: prepared as PreparedCardRow[] });
  expect(payload.products.map(p => [p.sourceId, p.priceHigh, p.priceLow])).toEqual([
    ['IADB1', 57000, 57000], ['IAP1', 11000, 10000],
  ]);
  expect(match.priceSources).toEqual({
    IADB1: { source: 'shinsoku', source_id: 'IADB1', price: 60000 },
    IAP1: { source: 'shinsoku', source_id: 'IAP1', price: 12000 },
  });
});
