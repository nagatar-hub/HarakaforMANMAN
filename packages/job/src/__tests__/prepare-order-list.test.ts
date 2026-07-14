import type { Database, Franchise } from '@haraka/shared';
import { prepareOrderListCards } from '../lib/prepare-order-list';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];

function makeRawImport(overrides: Partial<RawImportRow> = {}): RawImportRow {
  return {
    id: 'raw-1',
    run_id: 'run-1',
    order_list_item_id: 'item-1',
    excel_product_id: 'excel-1',
    db_card_id: 'db-1',
    franchise: 'Pokemon',
    card_name: 'リザードン',
    grade: 'PSA10',
    list_no: '001',
    image_url: 'https://excel.example/card.jpg',
    rarity: 'SAR',
    demand: 2,
    kecak_price: null,
    source_price: 50_000,
    price_source: 'order_list',
    raw_row: {},
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeDbCard(overrides: Partial<DbCardRow> = {}): DbCardRow {
  return {
    id: 'db-1',
    franchise: 'Pokemon',
    tag: 'TOP',
    card_name: 'リザードン',
    grade: 'PSA10',
    list_no: '001',
    image_url: 'https://db.example/card.jpg',
    alt_image_url: 'https://db.example/alternative.jpg',
    rarity_icon: 'https://db.example/rarity.png',
    sheet_row_number: 2,
    image_status: 'ok',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('prepareOrderListCards', () => {
  it.each<[Franchise, number, number]>([
    ['Pokemon', 44_500, 39_000],
    ['ONE PIECE', 44_500, 39_000],
    ['YU-GI-OH!', 42_500, 36_000],
  ])('%s はMANMAN既定の商材別率で価格を計算する', (franchise, expectedHigh, expectedLow) => {
    const raw = makeRawImport({ franchise });
    const result = prepareOrderListCards(
      [raw],
      new Map([['db-1', makeDbCard({ franchise })]]),
      '2026-07-14',
    );

    expect(result[0].price_high).toBe(expectedHigh);
    expect(result[0].price_low).toBe(expectedLow);
  });

  it('Excel画像をprimary、DBの代替画像をfallbackとして保持する', () => {
    const result = prepareOrderListCards(
      [makeRawImport()],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    );

    expect(result[0]).toMatchObject({
      run_id: 'run-1',
      raw_import_id: 'raw-1',
      order_list_item_id: 'item-1',
      excel_product_id: 'excel-1',
      db_card_id: 'db-1',
      image_url: 'https://excel.example/card.jpg',
      alt_image_url: 'https://db.example/alternative.jpg',
      rarity_icon_url: 'https://db.example/rarity.png',
      tag: 'TOP',
      source: 'order_list',
      price_source: 'order_list',
      price_source_date: '2026-07-14',
    });
  });

  it('DBの代替画像がなければDBの通常画像へfallbackする', () => {
    const result = prepareOrderListCards(
      [makeRawImport()],
      new Map([['db-1', makeDbCard({ alt_image_url: null })]]),
      '2026-07-14',
    );

    expect(result[0].alt_image_url).toBe('https://db.example/card.jpg');
  });

  it('order_list の source_price がなければ旧KECAK価格を使用しない', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ source_price: null, kecak_price: 100_000 })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('オーダーリスト価格がありません');
  });

  it('db_card_id がない行を名前照合で補完せず失敗させる', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ db_card_id: null })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('db_card_id がありません');
  });

  it('永続対応先が消えている行を名前照合で補完せず失敗させる', () => {
    expect(() => prepareOrderListCards(
      [makeRawImport({ db_card_id: 'missing-db' })],
      new Map([['db-1', makeDbCard()]]),
      '2026-07-14',
    )).toThrow('対応先DB商品が見つかりません');
  });
});
