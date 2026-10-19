import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts, type TokyoCandidate } from '../jobs/tokyo-buyback-sync';
import { extorecaPsaCandidates, parseExtorecaSheet } from '../lib/extoreca-sheet';

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

test('BOX uses only 希望卸金額(エクス), excludes examples and applies the existing 10% rounding', () => {
  const rows = parseExtorecaSheet(boxCsv, 'BOX');
  expect(rows).toEqual([expect.objectContaining({ name: 'テラスタルフェスex', price: 54000, productType: 'BOX' })]);
  const candidate: TokyoCandidate = { source: 'extoreca', id: rows[0].id, franchise: 'Pokemon',
    name: rows[0].name, modelNumber: null, productType: 'BOX', sourcePrice: rows[0].price };
  expect(compareTokyoSourceProducts([candidate], [], normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z')
    .products[0]).toMatchObject({ source_price: 54000, price_high: 48000, price_low: 48000,
      selected_high_source: 'extoreca', selected_low_source: 'extoreca' });
});

test('the higher price after reduction wins even when Extoreca has the higher raw price', () => {
  const extoreca: TokyoCandidate = { source: 'extoreca', id: 'sheet:box:2', franchise: 'Pokemon',
    name: 'テストBOX', modelNumber: null, productType: 'BOX', sourcePrice: 100000 };
  const result = compareTokyoSourceProducts([extoreca], [{ id: 'shinsoku-box', franchise: 'Pokemon',
    name: 'テストBOX', modelNumber: null, productType: 'BOX', price: 99000, imageUrl: null }],
  normalizeStorePricingSettings({}), '2026-10-19T00:00:00Z');
  // Extoreca 90,000円より、減額・端数処理後94,000円のShinsokuを採用する。
  expect(result.products[0]).toMatchObject({ source_price: 99000, price_high: 94000, price_low: 94000,
    selected_high_source: 'shinsoku', selected_low_source: 'shinsoku' });
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
