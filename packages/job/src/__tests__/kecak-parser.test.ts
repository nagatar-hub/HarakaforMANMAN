/**
 * kecak-parser のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/kecak-parser.ts に書く
 */

import { parseKecakRows } from '../lib/kecak-parser';
import type { Franchise } from '@haraka/shared';

// ダミー run_id
const RUN_ID = 'run-test-001';

// YU-GI-OH! のサンプル行（ヘッダ + データ行）
// col: 0=card_name, 1=grade, 3=list_no, 4=rarity, 5=image_url, 7=kecak_price
const YU_GI_OH_HEADER = ['カード名', 'グレード', '(空)', 'リスト番号', 'レアリティ', '画像URL', '(空2)', 'KECAK価格'];
const YU_GI_OH_ROW_1 = ['ブラック・マジシャン', 'PSA10', '', 'LOB-001', 'ウルトラレア', 'https://example.com/img1.jpg', '', '50000'];
const YU_GI_OH_ROW_2 = ['青眼の白龍', 'PSA9', '', 'LOB-002', 'ウルトラレア', 'https://example.com/img2.jpg', '', '30000'];
const YU_GI_OH_EMPTY = ['', '', '', '', '', '', '', ''];

// Pokemon のサンプル行（ヘッダ + データ行）
// col: 0=card_name, 1=grade, 2=list_no, 3=image_url, 5=kecak_price
const POKEMON_HEADER = ['カード名', 'グレード', 'リスト番号', '画像URL', '(空)', 'KECAK価格'];
const POKEMON_ROW_1 = ['リザードン', 'PSA10', '4/102', 'https://example.com/poke1.jpg', '', '200000'];
const POKEMON_ROW_2 = ['ピカチュウ', 'PSA8', '58/102', 'https://example.com/poke2.jpg', '', '15000'];

describe('parseKecakRows - YU-GI-OH!', () => {
  const franchise: Franchise = 'YU-GI-OH!';

  it('ヘッダ行（1行目）をスキップして残りの行を変換する', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1, YU_GI_OH_ROW_2];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result).toHaveLength(2);
  });

  it('card_name が空の行をスキップする', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1, YU_GI_OH_EMPTY, YU_GI_OH_ROW_2];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result).toHaveLength(2);
  });

  it('card_name を index 0 から取得する', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].card_name).toBe('ブラック・マジシャン');
  });

  it('grade を index 1 から取得する', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].grade).toBe('PSA10');
  });

  it('list_no を index 3 から取得する（YU-GI-OH! は D列）', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].list_no).toBe('LOB-001');
  });

  it('rarity を index 4 から取得する（YU-GI-OH! は E列）', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].rarity).toBe('ウルトラレア');
  });

  it('image_url を index 5 から取得する（YU-GI-OH! は F列）', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].image_url).toBe('https://example.com/img1.jpg');
  });

  it('kecak_price を index 7 から取得して数値に変換する（YU-GI-OH! は H列）', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].kecak_price).toBe(50000);
  });

  it('run_id と franchise が正しく設定される', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].run_id).toBe(RUN_ID);
    expect(result[0].franchise).toBe('YU-GI-OH!');
  });

  it('raw_row に元の行データが JSONB として保存される', () => {
    const rows = [YU_GI_OH_HEADER, YU_GI_OH_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].raw_row).toEqual({ '0': 'ブラック・マジシャン', '1': 'PSA10', '2': '', '3': 'LOB-001', '4': 'ウルトラレア', '5': 'https://example.com/img1.jpg', '6': '', '7': '50000' });
  });

  it('kecak_price が空文字の場合は null を設定する', () => {
    const rowWithNoPrice = ['テストカード', 'PSA10', '', 'TEST-001', 'レア', 'https://example.com/test.jpg', '', ''];
    const rows = [YU_GI_OH_HEADER, rowWithNoPrice];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].kecak_price).toBeNull();
  });

  it('kecak_price が ¥ 記号付きの場合でも正しく数値に変換する', () => {
    const rowWithYen = ['テストカード', 'PSA10', '', 'TEST-001', 'レア', 'https://example.com/test.jpg', '80', '¥7,800'];
    const rows = [YU_GI_OH_HEADER, rowWithYen];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].kecak_price).toBe(7800);
  });

  it('demand を正しく取得する（YU-GI-OH! は index 6）', () => {
    const rowWithDemand = ['テストカード', 'PSA10', '', 'TEST-001', 'レア', 'https://example.com/test.jpg', '80', '¥7,800'];
    const rows = [YU_GI_OH_HEADER, rowWithDemand];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].demand).toBe(80);
  });

  it('NFC正規化を適用する', () => {
    // NFC正規化: 濁点が結合文字として入力されたケース
    const rowWithNFD = ['\u30D6\u30E9\u30C3\u30AF\u30FB\u30DE\u30B8\u30B7\u30E3\u30F3', 'PSA10', '', 'LOB-001', 'レア', 'https://example.com/img.jpg', '', '50000'];
    const rows = [YU_GI_OH_HEADER, rowWithNFD];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    // NFC正規化後と同じであることを確認
    expect(result[0].card_name).toBe('ブラック・マジシャン'.normalize('NFC'));
  });

  it('ヘッダのみの場合は空配列を返す', () => {
    const rows = [YU_GI_OH_HEADER];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result).toHaveLength(0);
  });

  it('空配列の場合は空配列を返す', () => {
    const result = parseKecakRows([], franchise, RUN_ID);
    expect(result).toHaveLength(0);
  });
});

describe('parseKecakRows - Pokemon', () => {
  const franchise: Franchise = 'Pokemon';

  it('card_name を index 0 から取得する', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].card_name).toBe('リザードン');
  });

  it('grade を index 1 から取得する', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].grade).toBe('PSA10');
  });

  it('list_no を index 2 から取得する（Pokemon は C列）', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].list_no).toBe('4/102');
  });

  it('image_url を index 3 から取得する（Pokemon は D列）', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].image_url).toBe('https://example.com/poke1.jpg');
  });

  it('kecak_price を index 5 から取得する（Pokemon は F列）', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].kecak_price).toBe(200000);
  });

  it('franchise が Pokemon に設定される', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].franchise).toBe('Pokemon');
  });

  it('rarity は null になる（Pokemon シートには E 列がない）', () => {
    const rows = [POKEMON_HEADER, POKEMON_ROW_1];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].rarity).toBeNull();
  });

  it('kecak_price が ¥ 記号付きの場合でも正しく数値に変換する', () => {
    const header = ['カード名', 'グレード', 'リスト番号', '画像URL', '需要', 'KECAK価格'];
    const row = ['リザードン', 'PSA10', '4/102', 'https://example.com/poke1.jpg', '62', '¥24,000'];
    const rows = [header, row];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].kecak_price).toBe(24000);
  });

  it('demand を正しく取得する（Pokemon は index 4）', () => {
    const header = ['カード名', 'グレード', 'リスト番号', '画像URL', '需要', 'KECAK価格'];
    const row = ['リザードン', 'PSA10', '4/102', 'https://example.com/poke1.jpg', '62', '¥24,000'];
    const rows = [header, row];
    const result = parseKecakRows(rows, franchise, RUN_ID);
    expect(result[0].demand).toBe(62);
  });
});

describe('parseKecakRows - ONE PIECE', () => {
  const franchise: Franchise = 'ONE PIECE';

  it('ONE PIECE も Pokemon と同じカラムマッピングを使用する', () => {
    // col: 0=card_name, 1=grade, 2=list_no, 3=image_url, 5=kecak_price
    const header = ['カード名', 'グレード', 'リスト番号', '画像URL', '(空)', 'KECAK価格'];
    const row = ['ルフィ', 'PSA10', 'OP01-001', 'https://example.com/op1.jpg', '', '80000'];
    const rows = [header, row];
    const result = parseKecakRows(rows, franchise, RUN_ID);

    expect(result[0].card_name).toBe('ルフィ');
    expect(result[0].list_no).toBe('OP01-001');
    expect(result[0].image_url).toBe('https://example.com/op1.jpg');
    expect(result[0].kecak_price).toBe(80000);
    expect(result[0].franchise).toBe('ONE PIECE');
  });
});
