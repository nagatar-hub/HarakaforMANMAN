import { normalizeStorePricingSettings } from '@haraka/shared';
import {
  compareTokyoSourceProducts, runTokyoBuybackSync, tokyoDisplayPrice, tokyoProductCandidates,
  type TokyoCandidate,
} from '../jobs/tokyo-buyback-sync';
import { blueRocketCardName, blueRocketModelNumber, blueRocketPsaCandidates, parseBlueRocketPsaSheet } from '../lib/blue-rocket-sheet';
import type { ShinsokuPostalProduct } from '@haraka/shared';

const SETTINGS = normalizeStorePricingSettings({});
const OBSERVED_AT = '2026-09-09T05:00:00.000Z';
const OFFICIAL: ShinsokuPostalProduct = { id: 'IAP1', franchise: 'Pokemon', name: 'カイ',
  modelNumber: '236/172', productType: 'PSA10', price: 100000, imageUrl: 'official.jpg' };
/** ブルーロケット自社シートの PSA10 行（同期ではシートから作られる）。 */
const blueRocket = (price: number, name = 'カイ', modelNumber = '236/172'): TokyoCandidate => ({
  source: 'blue_rocket', id: `sheet:${price}`, franchise: 'Pokemon', name, modelNumber, productType: 'PSA10',
  sourcePrice: price, observedAt: OBSERVED_AT });
const kecak = (price: number) => tokyoProductCandidates([
  { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: price },
], [], []);

test('lineup takes KECAK and only Blue Rocket BOX from the checker; bank, Avirile and checker PSA are ignored', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'unmatched', source_price: 70000 },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '素体', list_no: '1', grade: 'S', match_status: 'matched', source_price: 1 },
    { id: 'k3', excel_product_id: 'k3', franchise: 'WEISS SCHWARZ', card_name: '旧KECAKヴァイス', list_no: '1', grade: 'PSA10', match_status: 'matched', source_price: 80000 },
    { id: 'ky', excel_product_id: 'ky', franchise: 'YU-GI-OH!', card_name: 'KECAK遊戯除外', list_no: 'Y/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
  ], [
    { source_product_id: 2, category: 'pokemon', name: 'バンクのみ', full_name: null, model_number: '2' },
    { source_product_id: 3, category: 'one_piece', name: 'ブルロケBOX', full_name: null, model_number: null },
  ], [
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: 9000 },
    { source_product_id: 3, shop_id: 13, condition_id: 2, edition_id: 0, buy_price: 8000 },
    { source_product_id: 2, shop_id: 11, condition_id: 1, edition_id: 0, buy_price: 9500 },
    { source_product_id: 3, shop_id: 11, condition_id: 2, edition_id: 0, buy_price: 8500 },
  ]);
  expect(candidates.map(row => [row.source, row.productType, row.sourcePrice])).toEqual([
    ['kecak', 'PSA10', 70000], ['kecak', 'PSA10', 80000], ['blue_rocket', 'BOX', 8500]]);
  expect(candidates.some(row => row.franchise === 'YU-GI-OH!')).toBe(false);
});

test('checker Blue Rocket BOX offers outside the Tokyo business date never enter the lineup', () => {
  const products = [{ source_product_id: 2, category: 'pokemon', name: 'BOX', full_name: null, model_number: null }];
  const candidates = tokyoProductCandidates([], products, [
    { source_product_id: 2, shop_id: 11, condition_id: 2, edition_id: 0, buy_price: 9000, source_updated_at: '2026-09-23T00:30:00+09:00' },
    { source_product_id: 2, shop_id: 11, condition_id: 2, edition_id: 1, buy_price: 9500, source_updated_at: '2026-09-22T23:30:00+09:00' },
    { source_product_id: 2, shop_id: 11, condition_id: 2, edition_id: 2, buy_price: 9800, source_updated_at: null },
  ], { businessDate: '2026-09-23' });
  expect(candidates.map(row => [row.source, row.sourcePrice])).toEqual([['blue_rocket', 9000]]);
});

test('a previous-day KECAK order list keeps its lineup row but never prices as today', () => {
  const rows = [{ id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172',
    grade: 'PSA10', match_status: 'matched', source_price: 130000 }];
  const current = tokyoProductCandidates(rows, [], [], { businessDate: '2026-09-23', kecakBusinessDate: '2026-09-23' });
  const stale = tokyoProductCandidates(rows, [], [], { businessDate: '2026-09-23', kecakBusinessDate: '2026-09-22' });
  expect(current.map(row => [row.source, row.sourcePrice])).toEqual([['kecak', 130000]]);
  // 商品はラインアップに残るが、前日の金額は比較へ出さない。
  expect(stale.map(row => [row.source, row.sourcePrice])).toEqual([['kecak', null]]);
  // 他ソースが当日価格を持てば、そちらだけで掲載が続く。
  expect(compareTokyoSourceProducts(stale, [OFFICIAL], SETTINGS, OBSERVED_AT).products
    .map(product => [product.selected_high_source, product.source_price])).toEqual([['shinsoku', 100000]]);
  const alone = compareTokyoSourceProducts(stale, [], SETTINGS, OBSERVED_AT);
  expect(alone.products).toEqual([]);
  // 「不正な価格」ではなく「当日でないので不参加」として報告する。
  expect(alone.unmatched.map(row => row.reason)).toEqual(['stale_price']);
});

test('KECAK, Shinsoku and Blue Rocket compete on raw price and the winner applies its own rate', () => {
  const result = compareTokyoSourceProducts([...kecak(110000), blueRocket(100000)], [OFFICIAL], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ id: 'IAP1', name: 'カイ', image_url: 'official.jpg',
    source_price: 110000, price_high: 100000, price_low: 100000,
    selected_high_source: 'kecak', selected_low_source: 'kecak' });
  expect(result.products[0].origins.map(origin => [origin.source, origin.rawPrice])).toEqual([
    ['kecak', 110000], ['blue_rocket', 100000], ['shinsoku', 100000]]);
  expect(result.priceSources).toEqual({ IAP1: { source: 'kecak', source_id: 'k1', price: 110000 } });
  expect(result.unmatched).toEqual([]);
});

test('the highest raw price wins even when another source would be higher after its own discount', () => {
  const settings = normalizeStorePricingSettings({ tokyo_source_discount_rates: {
    blue_rocket: { high: 0.30, low: 0.30 }, shinsoku: { high: 0.00, low: 0.00 } } });
  const result = compareTokyoSourceProducts([blueRocket(120000)], [OFFICIAL], settings, OBSERVED_AT);
  // ブルロケ 120,000 × 70% = 84,000 < シンソク 100,000 × 100% だが、元価格が高いブルロケを採用する。
  expect(result.products[0]).toMatchObject({ source_price: 120000, price_high: 84000, price_low: 84000,
    selected_high_source: 'blue_rocket', selected_low_source: 'blue_rocket' });
});

test('high and low both come from the chosen source; equal raw prices go to the higher discounted price', () => {
  const settings = normalizeStorePricingSettings({ tokyo_source_discount_rates: {
    kecak: { high: 0.05, low: 0.20 }, shinsoku: { high: 0.10, low: 0.10 } } });
  const result = compareTokyoSourceProducts(kecak(100000), [OFFICIAL], settings, OBSERVED_AT);
  expect(result.products[0]).toMatchObject({ price_high: 95000, selected_high_source: 'kecak',
    price_low: 80000, selected_low_source: 'kecak' });
});

test('a Blue Rocket BOX publishes on its own and only Shinsoku supplies the catalog id', () => {
  const candidates = tokyoProductCandidates([], [
    { source_product_id: 9, category: 'one_piece', name: 'ブースターパック', full_name: null, model_number: null, image_url: 'checker.jpg' },
  ], [
    { source_product_id: 9, shop_id: 11, condition_id: 2, edition_id: 0, buy_price: 50000 },
  ]);
  const shinsokuOnly: ShinsokuPostalProduct = { id: 'IAY1', franchise: 'YU-GI-OH!', name: '青眼の白龍',
    modelNumber: 'LB01-JP000', productType: 'PSA10', price: 80000, imageUrl: 'y.jpg' };
  const result = compareTokyoSourceProducts(candidates, [shinsokuOnly], SETTINGS, OBSERVED_AT);
  const byName = Object.fromEntries(result.products.map(product => [product.name, product]));
  expect(byName['ブースターパック']).toMatchObject({ id: expect.stringMatching(/^TOKYO_[0-9a-f]{64}$/),
    source_price: 50000, selected_high_source: 'blue_rocket', image_url: 'checker.jpg', product_type: 'box' });
  expect(byName['青眼の白龍']).toMatchObject({ id: 'IAY1', price_high: 76000, price_low: 76000,
    selected_high_source: 'shinsoku' });
});

test.each([null, 0, -1, 1.5, NaN, Infinity, 100000001])('an invalid price %s never reaches a published product', price => {
  const result = compareTokyoSourceProducts([], [{ ...OFFICIAL, price }], SETTINGS, OBSERVED_AT);
  expect(result.products).toEqual([]);
  expect(result.priceSources).toEqual({});
  expect(result.unmatched).toEqual([
    { candidate: expect.objectContaining({ source: 'shinsoku', id: 'IAP1' }), reason: 'invalid_price' },
  ]);
});

test('rows without a model number, with split source prices, or discounted to zero stay unpublished', () => {
  const noModel = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'no-model', modelNumber: '  ' }], SETTINGS, OBSERVED_AT);
  expect(noModel.products).toEqual([]);
  expect(noModel.unmatched.map(row => row.reason)).toEqual(['missing_model']);

  const split = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'a', price: 10000 },
    { ...OFFICIAL, id: 'b', price: 20000 }], SETTINGS, OBSERVED_AT);
  expect(split.products).toEqual([]);
  expect(split.unmatched.map(row => row.reason)).toEqual(['ambiguous', 'ambiguous']);

  const tiny = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'tiny', price: 1 }], SETTINGS, OBSERVED_AT);
  expect(tiny.products).toEqual([]);
  expect(tiny.unmatched.map(row => row.reason)).toEqual(['zero_after_discount']);
});

test('a single absurd source price is excluded from the comparison instead of becoming the price', () => {
  const result = compareTokyoSourceProducts([...kecak(130000), blueRocket(99999999)],
    [{ ...OFFICIAL, price: 123000 }], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  // 99,999,999 は他2社の中央値 126,500 の 790 倍。除外して KECAK 130,000 を採用する。
  expect(result.products[0]).toMatchObject({ source_price: 130000, price_high: 120000,
    selected_high_source: 'kecak', selected_low_source: 'kecak' });
  expect(result.products[0].origins.map(origin => [origin.source, origin.rawPrice, origin.excluded ?? false])).toEqual([
    ['kecak', 130000, false], ['blue_rocket', 99999999, true], ['shinsoku', 123000, false],
  ]);
});

test('the outlier guard is configurable and keeps legitimate price gaps', () => {
  const group = (blueRocketPrice: number, guard: { max_median_ratio: number; max_source_price: number }) =>
    compareTokyoSourceProducts([...kecak(50000), blueRocket(blueRocketPrice)], [{ ...OFFICIAL, price: 50000 }],
      normalizeStorePricingSettings({ tokyo_outlier_guard: guard }), OBSERVED_AT);
  const lenient = { max_median_ratio: 10, max_source_price: 10_000_000 };
  // 200,000 / 50,000 = 4倍。正常な価格差なので除外しない。
  expect(group(200000, lenient).products[0]).toMatchObject({ selected_high_source: 'blue_rocket', source_price: 200000 });
  // 同じ値でも倍率を 3 に絞れば除外される。
  expect(group(200000, { ...lenient, max_median_ratio: 3 }).products[0]).toMatchObject({ selected_high_source: 'kecak', source_price: 50000 });
  // 倍率では届かない単独の高値も、元価格上限で切れる。
  expect(group(200000, { ...lenient, max_source_price: 150000 }).products[0]).toMatchObject({ selected_high_source: 'kecak', source_price: 50000 });
});

test('a lone source is judged by the absolute ceiling only, and an over-ceiling product stays unpublished', () => {
  const guard = normalizeStorePricingSettings({ tokyo_outlier_guard: { max_median_ratio: 10, max_source_price: 1_000_000 } });
  const lone = (price: number) => compareTokyoSourceProducts([blueRocket(price, 'ルフィ', '100/100')], [], guard, OBSERVED_AT);
  // 比較相手が居なくても上限以下なら公開する。
  expect(lone(900000).products[0]).toMatchObject({ source_price: 900000, selected_high_source: 'blue_rocket' });
  const over = lone(9000000);
  expect(over.products).toEqual([]);
  expect(over.unmatched.map(row => row.reason)).toEqual(['outlier_price']);
});

test('the per-source discount rate applies exactly once to the raw source price', () => {
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'PSA10', 0.07)).toBe(93000);
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'BOX', 0.07)).toBe(93000);
  expect(tokyoDisplayPrice(10098, 'Pokemon', 'PSA10', 0.05)).toBe(9000);
});

test('Blue Rocket sheet rows keep only the card name and a usable model number', () => {
  expect(blueRocketCardName('Nのゾロアークex SAR [M2a 242/193](ハイクラスパック「MEGAドリームex」)')).toBe('Nのゾロアークex');
  expect(blueRocketCardName('MレックウザEX: プロモ[S8a-P 024/025](プロモカードパック)')).toBe('MレックウザEX');
  expect(blueRocketCardName('R団のサンダー(25th): プロモ[025 008](プロモ)')).toBe('R団のサンダー(25th)');
  expect(blueRocketCardName('ピカチュウVMAX（バンザイピカチュウ）[S-P 123/S-P]')).toBe('ピカチュウVMAX');
  expect(blueRocketCardName('ミュウ ふしぎなしっぽ[CP5 030/028]')).toBe('ミュウ');
  // 言語違い・1ED・エラー版は名前に残す（日本語版・通常版として掲載しない）。
  expect(blueRocketCardName('ピカチュウ AR [151C 173/151]【中国語版】(スカーレット&バイオレット)')).toBe('ピカチュウ(中国語版)');
  expect(blueRocketCardName('ミュウツー R :1ED [CP6 049/087](コンセプトパック)')).toBe('ミュウツー(1ED)');
  expect(blueRocketCardName('ニンフィアEX RR :1ED [CP3 026/032](x) エラー版')).toBe('ニンフィアEX(1ED)(エラー版)');
  expect(blueRocketModelNumber('062/SV/P')).toBe('062/SV-P');
  expect(blueRocketModelNumber(' 242/193 ')).toBe('242/193');
  expect(blueRocketModelNumber('085')).toBeNull();
  expect(blueRocketModelNumber('0307/07')).toBeNull();
  const csv = [
    '"注記","金額","枚数","カード名","型番","","画像"',
    '"","18,000","15","MレックウザEX: プロモ[S8a-P 024/025](x)","024/025","","https://img/1.jpg"',
    '"","17,000","3","MレックウザEX: プロモ[S8a-P 024/025](x)","024/025","",""',
    '"","","1","価格なし[x]","001/001","",""',
    '"","410,000","1","ゴッホピカチュウ[SV-P]","085","",""',
  ].join('\n');
  // 同じカードが複数行あれば高い方だけ。価格や型番の無い行は使わない。
  expect(parseBlueRocketPsaSheet(csv)).toEqual([
    { id: 'sheet:2', name: 'MレックウザEX', modelNumber: '024/025', price: 18000, imageUrl: 'https://img/1.jpg' }]);
});

test('Blue Rocket rows whose model exists under another name are skipped instead of listed twice', () => {
  const lineup = [
    { franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10' as const },
    { franchise: 'Pokemon', name: 'ピカチュウ【P】', modelNumber: '218/SV-P', productType: 'PSA10' as const },
  ];
  const rows = [
    { id: 'sheet:2', name: 'カイ', modelNumber: '236/172', price: 1, imageUrl: null },
    { id: 'sheet:3', name: 'ピカチュウ', modelNumber: '218/SV-P', price: 2, imageUrl: null },
    { id: 'sheet:4', name: 'ヒトカゲ', modelNumber: '051/049', price: 3, imageUrl: null },
  ];
  const { used, skipped } = blueRocketPsaCandidates(rows, lineup);
  expect(used.map(row => row.id)).toEqual(['sheet:2', 'sheet:4']);
  expect(skipped).toEqual([{ name: 'ピカチュウ', modelNumber: '218/SV-P', price: 2 }]);
});

test('non-Tokyo jobs reject before accessing any DB or external source', async () => {
  const store = process.env.STORE_NAME;
  try {
    for (const name of ['manman', 'oripark', 'manman-tokyo', '']) {
      process.env.STORE_NAME = name;
      await expect(runTokyoBuybackSync({ dryRun: true })).rejects.toThrow('東京満満専用');
    }
  } finally {
    if (store === undefined) delete process.env.STORE_NAME; else process.env.STORE_NAME = store;
  }
});
