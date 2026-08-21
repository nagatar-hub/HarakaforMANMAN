/**
 * spectre-parser のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/spectre-parser.ts に書く
 */

import { parseSpectreRows, spectreIntersectionKey } from '../lib/spectre-parser';
import type { Franchise } from '@haraka/shared';

const RUN_ID = 'run-test-spectre';

// SpectreMapping のヘッダ行
// SPECTRE_MAP_COLS: GROUP=1, SPECTRE_NAME=2, SPECTRE_PRICE=3, IMAGE_URL=4,
//                   HARAKA_NAME=5, HARAKA_TYPE=6, HARAKA_CARD_NO=7, BUY_PRICE=8
const HEADER = ['グループ', 'Spectre名', 'Spectre価格', '画像URL', 'Haraka名', 'Haraka種別', 'Harakaカード番号', '買取価格'];

const ROW_CHARIZARD = ['TOP', 'リザードンex SAR', '¥35,000', 'https://img/char.jpg', 'リザードンex', 'PSA10', '4/102', '30000'];
const ROW_PIKACHU = ['TOP', 'ピカチュウ AR', '¥12,000', 'https://img/pika.jpg', 'ピカチュウ', 'PSA10', '58/102', '10000'];
const ROW_EMPTY_NAME = ['', '', '', '', '', '', '', ''];
const ROW_WITH_YEN = ['BOX', 'ミュウex', '¥8,000', 'https://img/mew.jpg', 'ミュウex', 'PSA9', '151/165', '¥7,000'];
const ROW_NO_PRICE = ['TOP', 'フシギバナex', '¥5,000', 'https://img/venu.jpg', 'フシギバナex', 'PSA10', '3/102', ''];

describe('parseSpectreRows', () => {
  const franchise: Franchise = 'Pokemon';

  it('ヘッダ行をスキップしてデータ行を変換する', () => {
    const rows = [HEADER, ROW_CHARIZARD, ROW_PIKACHU];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result).toHaveLength(2);
  });

  it('card_name を SPECTRE_NAME（index 1）から取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].card_name).toBe('リザードンex SAR');
  });

  it('tag を GROUP（index 0）から取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].tag).toBe('TOP');
  });

  it('image_url を IMAGE_URL（index 3）から取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].image_url).toBe('https://img/char.jpg');
  });

  it('grade を HARAKA_TYPE（index 5）から取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].grade).toBe('PSA10');
  });

  it('list_no を HARAKA_CARD_NO（index 6）から取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].list_no).toBe('4/102');
  });

  it('price_high を BUY_PRICE（index 7）に商材別減額率を反映して取得する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].price_high).toBe(26000);
  });

  it('price_high に指定された商材別減額率を反映する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID, { Pokemon: 0.10, 'ONE PIECE': 0.20 });
    expect(result[0].price_high).toBe(27000);
  });

  it('price_high が ¥ 記号付きでも正しく数値に変換する', () => {
    const rows = [HEADER, ROW_WITH_YEN];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].price_high).toBe(6100);
  });

  it('price_low が calculateBuyPriceLow で計算される', () => {
    // 商材別 12% 減額: 30000 -> 26400 -> price_high 26000
    // Pokemon: 26000 >= 20000 → rate=0.88 → 26000*0.88=22880 → niceLowerBound=22000
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].price_low).toBe(22000);
  });

  it('商材別減額率が指定された場合はその率で price_high を計算する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID, { Pokemon: 0.10 });
    expect(result[0].price_high).toBe(27000);
    expect(result[0].price_low).toBe(23000);
  });

  it('price_high は割引後の金額帯に応じて切り捨てる', () => {
    const rows = [HEADER, ['TOP', 'ナミ', '¥30,090', 'https://img/nami.jpg', 'ナミ', 'PSA10', 'OP00-001', '30090']];
    const result = parseSpectreRows(rows, 'ONE PIECE', RUN_ID, { 'ONE PIECE': 0.06 });
    expect(result[0].price_high).toBe(28000);
  });

  it('source = "spectre" が設定される', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].source).toBe('spectre');
  });

  it('franchise と run_id が正しく設定される', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].franchise).toBe('Pokemon');
    expect(result[0].run_id).toBe(RUN_ID);
  });

  it('SPECTRE_NAME が空の行をスキップする', () => {
    const rows = [HEADER, ROW_CHARIZARD, ROW_EMPTY_NAME, ROW_PIKACHU];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result).toHaveLength(2);
  });

  it('空配列は空配列を返す', () => {
    const result = parseSpectreRows([], franchise, RUN_ID);
    expect(result).toHaveLength(0);
  });

  it('ヘッダのみは空配列を返す', () => {
    const result = parseSpectreRows([HEADER], franchise, RUN_ID);
    expect(result).toHaveLength(0);
  });

  it('image_status = "unchecked" が設定される', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].image_status).toBe('unchecked');
  });

  it('raw_import_id は null（Spectre は raw_import 経由しない）', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].raw_import_id).toBeNull();
  });

  it('NFC正規化を適用する', () => {
    const nfdRow = [
      'TOP',
      'リザードン'.normalize('NFD'),
      '¥10,000',
      'https://img/test.jpg',
      'リザードン',
      'PSA10',
      '1/102',
      '8000',
    ];
    const rows = [HEADER, nfdRow];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].card_name).toBe('リザードン'.normalize('NFC'));
  });

  it('BUY_PRICE が空の場合 price_high / price_low が null になる', () => {
    const rows = [HEADER, ROW_NO_PRICE];
    const result = parseSpectreRows(rows, franchise, RUN_ID);
    expect(result[0].price_high).toBeNull();
    expect(result[0].price_low).toBeNull();
  });

  it('YU-GI-OH! の franchise でも正しく動作する', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const result = parseSpectreRows(rows, 'YU-GI-OH!', RUN_ID);
    expect(result[0].franchise).toBe('YU-GI-OH!');
    // 買取上限 15% 減額: 30000 -> 25500 -> price_high 25000
    // YU-GI-OH!: 25000 * 0.85 = 21250 → niceLowerBound → 21000
    expect(result[0].price_low).toBe(21000);
  });

  it('Spectreタグ交差キーは同じ型番・種別でも商材を跨がない', () => {
    const tags = new Map([
      [spectreIntersectionKey('Pokemon', 'E-48', 'PSA10'), 'TOP'],
    ]);

    expect(tags.get(spectreIntersectionKey('Pokemon', 'E-48', 'PSA10'))).toBe('TOP');
    expect(tags.get(spectreIntersectionKey('DRAGON BALL', 'E-48', 'PSA10'))).toBeUndefined();
  });
});
