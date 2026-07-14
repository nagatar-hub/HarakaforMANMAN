import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchOrderListRows,
  normalizeImageUrl,
  type DbCardMatchInput,
  type MatchableOrderListRow,
} from '../lib/order-list-matcher';

function row(overrides: Partial<MatchableOrderListRow> = {}): MatchableOrderListRow {
  return {
    franchise: 'Pokemon',
    excelProductId: 'excel-1',
    cardName: 'リザードン',
    grade: 'PSA10',
    listNo: 'SV4a-349',
    imageUrl: 'https://excel.example/card.jpg',
    valid: true,
    validationIssues: [],
    ...overrides,
  };
}

function dbCard(overrides: Partial<DbCardMatchInput> = {}): DbCardMatchInput {
  return {
    id: 'db-1',
    franchise: 'Pokemon',
    card_name: 'リザードン',
    grade: 'PSA10',
    list_no: 'SV4a-349',
    image_url: 'https://db.example/card.jpg',
    alt_image_url: 'https://fallback.example/card.jpg',
    ...overrides,
  };
}

describe('matchOrderListRows', () => {
  it('保存済みExcel商品ID対応表を最優先する', () => {
    const cards = [
      dbCard({ id: 'mapped-card' }),
      dbCard({ id: 'image-card', image_url: 'https://excel.example/card.jpg' }),
    ];

    const [result] = matchOrderListRows([row()], cards, [{
      id: 'mapping-1',
      franchise: 'Pokemon',
      excel_product_id: 'excel-1',
      db_card_id: 'mapped-card',
      status: 'active',
    }]);

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'existing_mapping');
    assert.equal(result.dbCardId, 'mapped-card');
    assert.equal(result.mappingId, 'mapping-1');
  });

  it('同一商材で画像URLが1件だけ完全一致すれば自動照合する', () => {
    const [result] = matchOrderListRows(
      [row({ imageUrl: 'https://fallback.example/card.jpg#preview' })],
      [dbCard()],
      [],
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'exact_image');
    assert.equal(result.dbCardId, 'db-1');
  });

  it('同じ画像URLの候補が複数あれば先頭を採用せずambiguousにする', () => {
    const cards = [
      dbCard({ id: 'db-1', image_url: 'https://excel.example/card.jpg' }),
      dbCard({ id: 'db-2', image_url: 'https://excel.example/card.jpg' }),
    ];

    const [result] = matchOrderListRows([row()], cards, []);

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.dbCardId, null);
    assert.deepEqual(result.candidateDbCardIds, ['db-1', 'db-2']);
  });

  it('画像URLが複数候補でも商品情報の厳密一致が一意なら自動照合する', () => {
    const cards = [
      dbCard({ id: 'db-1', image_url: 'https://excel.example/card.jpg' }),
      dbCard({
        id: 'db-2',
        card_name: '別カード',
        list_no: 'OTHER-001',
        image_url: 'https://excel.example/card.jpg',
      }),
    ];

    const [result] = matchOrderListRows([row()], cards, []);

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'exact_identity');
    assert.equal(result.dbCardId, 'db-1');
  });

  it('商材・商品名・種別・リスト番号の正規化完全一致で自動照合する', () => {
    const [result] = matchOrderListRows(
      [row({
        cardName: ' リザードン ',
        grade: 'ＰＳＡ１０',
        listNo: 'SV4a-349',
        imageUrl: null,
      })],
      [dbCard()],
      [],
    );

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'exact_identity');
    assert.equal(result.dbCardId, 'db-1');
  });

  it('安全な候補がなければunmatchedとして保留する', () => {
    const [result] = matchOrderListRows(
      [row({ cardName: 'ミュウ', imageUrl: null })],
      [dbCard()],
      [],
    );

    assert.equal(result.status, 'unmatched');
    assert.equal(result.dbCardId, null);
  });

  it('パーサーでinvalidの行は照合しない', () => {
    const [result] = matchOrderListRows(
      [row({ valid: false, validationIssues: [{ code: 'PRICE_REQUIRED' }] })],
      [dbCard({ image_url: 'https://excel.example/card.jpg' })],
      [],
    );

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.candidateDbCardIds, []);
  });
});

describe('normalizeImageUrl', () => {
  it('hashと末尾slashだけを除き、queryは保持する', () => {
    assert.equal(
      normalizeImageUrl('https://Example.com/image/?v=1#x'),
      'https://example.com/image?v=1',
    );
  });

  it('http/https以外は照合対象にしない', () => {
    assert.equal(normalizeImageUrl('javascript:alert(1)'), null);
  });
});
