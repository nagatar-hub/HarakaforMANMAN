import { normalizeStorePricingSettings, postalProductIdentity } from '@haraka/shared';
import { compareTokyoSourceProducts, selectCheckerPsaCandidates, tokyoProductCandidates } from '../jobs/tokyo-buyback-sync';
import { parseCheckerShop } from '../lib/kaitori-checker-shops';

const SETTINGS = normalizeStorePricingSettings({});
const NOW = '2026-11-18T03:00:00Z';
const base = { product_id: 1, category_id: 1, name: 'ピカチュウ', model_number: '025/165',
  condition_id: 1, edition_id: 0, buy_price: 100000, price_updated_at: NOW, ask_flag: 0 };
const candidates = (rows: Record<string, unknown>[]) => {
  const shop = parseCheckerShop({ id: 44, name: 'ブルーロケット郵送', products: rows }, 44, [1, 2]);
  return tokyoProductCandidates([], shop.products, shop.offers, { businessDate: '2026-11-18' });
};

test('holo variants stay distinct through parsing, candidate selection and the final source comparison', () => {
  const rows = candidates([base, { ...base, product_id: 2, holo_type: 'マスターボールミラー', buy_price: 120000 }]);
  expect(rows.map(row => row.name)).toEqual(['ピカチュウ', 'ピカチュウ(マスターボールミラー)']);
  expect(new Set(rows.map(postalProductIdentity)).size).toBe(2);
  const lineup = [{ id: 'IAP1', franchise: 'Pokemon', name: 'ピカチュウ(マスターボールミラー)', modelNumber: '025/165',
    productType: 'PSA10' as const, price: 110000, imageUrl: null }];
  const selected = selectCheckerPsaCandidates(rows, lineup);
  expect(selected.used).toHaveLength(1);
  expect(selected.skipped[0].sourceProductId).toBe(1);
  const compared = compareTokyoSourceProducts(selected.used, lineup, SETTINGS, NOW);
  expect(compared.products).toHaveLength(1);
  expect(compared.products[0]).toMatchObject({ id: 'IAP1', source_price: 120000,
    origins: [{ source: 'blue_rocket', shopId: 44, shopName: 'ブルーロケット郵送' }, { source: 'shinsoku' }] });
});

test('ordinary PSA suffixes still match the existing catalog without dropping meaningful variants', () => {
  const rows = candidates([{ ...base, holo_type: 'AR仕様' }]);
  expect(selectCheckerPsaCandidates(rows, [{ ...rows[0], name: 'ピカチュウ' }]).used).toHaveLength(1);
  const unknown = candidates([{ ...base, model_number: '999/999', holo_type: 'マスターボールミラー' }]);
  expect(selectCheckerPsaCandidates(unknown, rows).used).toHaveLength(1);
});

test.each(['パラレル/漫画背景/漫画絵', 'レッドパラレル/漫画背景/漫画絵', '英語版'])('%s never merges with a plain card of the same model', aspect => {
  const rows = candidates([{ ...base, category_id: 2, name: 'モンキー・D・ルフィ', model_number: 'OP13-118', rarity: 'SEC/P', aspect }]);
  const plain = { ...rows[0], name: 'モンキー・D・ルフィ' };
  expect(postalProductIdentity(rows[0])).not.toBe(postalProductIdentity(plain));
  expect(selectCheckerPsaCandidates(rows, [plain])).toMatchObject({ used: [], skipped: rows });
  expect(selectCheckerPsaCandidates(rows, [{ ...plain, name: `モンキー・D・ルフィ(${aspect})` }]).used).toEqual(rows);
});

test('a parallel rarity with missing design data cannot take a plain card price', () => {
  const rows = candidates([{ ...base, category_id: 2, name: 'ナミ', model_number: 'OP01-016', rarity: 'R/P' }]);
  expect(rows[0].name).toBe('ナミ(レアリティ:R/P)');
  expect(selectCheckerPsaCandidates(rows, [{ ...rows[0], name: 'ナミ' }]).used).toEqual([]);
});

test('an existing variant in the name is not added a second time', () => {
  const rows = candidates([{ ...base, name: 'ピカチュウ(マスターボールミラー)', holo_type: 'マスターボールミラー' }]);
  expect(rows[0].name).toBe('ピカチュウ(マスターボールミラー)');
});

test('different source product IDs sharing a postal identity stay ambiguous', () => {
  const rows = candidates([base, { ...base, product_id: 2, buy_price: 120000 }]);
  const result = compareTokyoSourceProducts(rows, [], SETTINGS, NOW);
  expect(result.products).toEqual([]);
  expect(result.unmatched.map(row => row.reason)).toEqual(['ambiguous', 'ambiguous']);
});

test('edition identity is preserved and two IDs with one edition label stay ambiguous', () => {
  const distinct = candidates([base, { ...base, edition_id: 1, edition_name: '初版' }]);
  expect(new Set(distinct.map(postalProductIdentity)).size).toBe(2);
  expect(compareTokyoSourceProducts(distinct, [], SETTINGS, NOW).products).toHaveLength(2);
  const ambiguous = candidates([{ ...base, edition_id: 1, edition_name: '初版' }, { ...base, edition_id: 2, edition_name: '初版' }]);
  expect(compareTokyoSourceProducts(ambiguous, [], SETTINGS, NOW).products).toEqual([]);
});
