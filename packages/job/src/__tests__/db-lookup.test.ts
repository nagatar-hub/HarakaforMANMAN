/**
 * db-lookup のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/db-lookup.ts に書く
 */

import { buildLookupMap, lookupCard } from '../lib/db-lookup';

// DB_COLS の定義（1-indexed → array index = value - 1）
// FRANCHISE: 1 (idx 0), GROUP: 2 (idx 1), CARD_NAME: 3 (idx 2),
// TYPE: 4 (idx 3), CARD_NO: 5 (idx 4), IMAGE: 6 (idx 5),
// ALT_IMAGE: 7 (idx 6), RARITY_ICON: 8 (idx 7)

// ヘッダ行
const HEADER = ['タイトル', 'タグ', 'ガチャ選択肢名称', '種別', 'list_no', '画像', '代替画像', 'レアリティアイコン'];

// データ行
// [franchise, group, card_name, type/grade, card_no, image, alt_image, rarity_icon]
const ROW_CHARIZARD = ['Pokemon', 'タグ-リザードン', 'リザードン', 'PSA10', '4/102', 'https://primary/char.jpg', 'https://img/char.jpg', '1'];
const ROW_CHARIZARD_PSA9 = ['Pokemon', 'タグ-リザードン', 'リザードン', 'PSA9', '4/102', 'https://primary/char9.jpg', 'https://img/char9.jpg', '1'];
const ROW_PIKACHU = ['Pokemon', 'タグ-ピカチュウ', 'ピカチュウ', 'PSA10', '58/102', 'https://primary/pika.jpg', 'https://img/pika.jpg', '2'];
const ROW_BLACK_MAGE = ['YU-GI-OH!', 'タグ-BM', 'ブラック・マジシャン', 'PSA10', 'LOB-001', 'https://primary/bm.jpg', 'https://img/bm.jpg', '3'];
const ROW_NO_ICON = ['Pokemon', 'タグ-フシギダネ', 'フシギダネ', 'PSA8', '1/102', 'https://primary/bulb.jpg', 'https://img/bulb.jpg', ''];

describe('buildLookupMap', () => {
  it('ヘッダ行（1行目）をスキップする', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    // ヘッダの "ガチャ選択肢名称" でマッチしないことを確認
    const result = lookupCard(map, { card_name: 'ガチャ選択肢名称' });
    expect(result).toBeNull();
  });

  it('card_name が空の行をスキップする', () => {
    const emptyNameRow = ['Pokemon', 'タグ', '', 'PSA10', '1/102', 'https://primary/test.jpg', 'https://img/test.jpg', ''];
    const rows = [HEADER, emptyNameRow, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    // emptyNameRow は無視されて、1件のみ登録される
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    expect(result).not.toBeNull();
  });

  it('空配列でも正常に動作する（空のマップを返す）', () => {
    const map = buildLookupMap([]);
    const result = lookupCard(map, { card_name: 'リザードン' });
    expect(result).toBeNull();
  });

  it('ヘッダのみでも正常に動作する', () => {
    const map = buildLookupMap([HEADER]);
    const result = lookupCard(map, { card_name: 'リザードン' });
    expect(result).toBeNull();
  });
});

describe('lookupCard - exact（3段階: card_name + grade + list_no）', () => {
  it('card_name + grade + list_no の完全一致でマッチする', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-リザードン');
  });

  it('完全一致で imageUrl（ALT_IMAGE列）を正しく返す', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    expect(result?.imageUrl).toBe('https://img/char.jpg');
  });

  it('完全一致で rarityIcon を正しく返す', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    expect(result?.rarityIcon).toBe('1');
  });

  it('rarity_icon が空の場合は null を返す', () => {
    const rows = [HEADER, ROW_NO_ICON];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'フシギダネ', grade: 'PSA8', list_no: '1/102' });
    expect(result?.rarityIcon).toBeNull();
  });

  it('alt_image が空の場合は null を返す', () => {
    const noAltImageRow = ['Pokemon', 'タグ', 'テスト', 'PSA10', '1/1', 'https://primary/test.jpg', '', ''];
    const rows = [HEADER, noAltImageRow];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'テスト', grade: 'PSA10', list_no: '1/1' });
    expect(result?.imageUrl).toBeNull();
  });

  it('PSA10 と PSA9 が同名カードで別々にマッチする', () => {
    const rows = [HEADER, ROW_CHARIZARD, ROW_CHARIZARD_PSA9];
    const map = buildLookupMap(rows);

    const psa10 = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    const psa9 = lookupCard(map, { card_name: 'リザードン', grade: 'PSA9', list_no: '4/102' });

    expect(psa10?.tag).toBe('タグ-リザードン');
    expect(psa9?.tag).toBe('タグ-リザードン');
  });
});

describe('lookupCard - nameGrade（card_name + grade）', () => {
  it('list_no がない場合は card_name + grade でマッチする', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: null });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-リザードン');
  });

  it('list_no が undefined の場合も card_name + grade でマッチする', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10' });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-リザードン');
  });

  it('list_no が異なる場合でも card_name + grade でフォールバックする', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    // list_no が違うので exact には当たらない → nameGrade にフォールバック
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: 'WRONG-999' });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-リザードン');
  });
});

describe('lookupCard - nameOnly（card_name のみ）', () => {
  it('grade がない場合は card_name だけでマッチする', () => {
    const rows = [HEADER, ROW_PIKACHU];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'ピカチュウ', grade: null });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-ピカチュウ');
  });

  it('grade と list_no がどちらも違う場合は card_name だけでフォールバックする', () => {
    const rows = [HEADER, ROW_PIKACHU];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'ピカチュウ', grade: 'PSA5', list_no: 'WRONG' });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-ピカチュウ');
  });
});

describe('lookupCard - マッチなし', () => {
  it('存在しないカード名では null を返す', () => {
    const rows = [HEADER, ROW_CHARIZARD];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: '存在しないカード' });
    expect(result).toBeNull();
  });
});

describe('lookupCard - NFC正規化', () => {
  it('NFC正規化した文字列でも正しくマッチする', () => {
    const rows = [HEADER, ROW_BLACK_MAGE];
    const map = buildLookupMap(rows);
    // NFD形式の入力でもNFC正規化後にマッチする
    const nfdName = 'ブラック・マジシャン'.normalize('NFD');
    const result = lookupCard(map, { card_name: nfdName, grade: 'PSA10', list_no: 'LOB-001' });
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-BM');
  });
});

describe('lookupCard - 優先度（exact > nameGrade > nameOnly）', () => {
  it('exact マッチがある場合は nameGrade より優先される', () => {
    // PSA10/4/102 と PSA9 が両方あるとき、PSA10 + 4/102 で検索すると exact がヒット
    const rows = [HEADER, ROW_CHARIZARD, ROW_CHARIZARD_PSA9];
    const map = buildLookupMap(rows);
    const result = lookupCard(map, { card_name: 'リザードン', grade: 'PSA10', list_no: '4/102' });
    // exact にマッチするので tag が返る
    expect(result).not.toBeNull();
    expect(result?.tag).toBe('タグ-リザードン');
  });
});
