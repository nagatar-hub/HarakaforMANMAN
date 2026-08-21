import type { GeneratedPageRow, OrderListItemRow, PreparedCardRow } from '@haraka/shared';
import {
  buildBuybackSheetValues,
  BUYBACK_SHEET_HEADERS,
  flattenGeneratedStorePageCardIds,
} from '../lib/buyback-sheet';

type PublishPage = Pick<GeneratedPageRow, 'franchise' | 'page_index' | 'card_ids' | 'status' | 'kind'>;

function makePage(overrides: Partial<PublishPage> = {}): PublishPage {
  return {
    franchise: 'Pokemon',
    page_index: 0,
    card_ids: ['pokemon-1'],
    status: 'generated',
    kind: 'store',
    ...overrides,
  };
}

function makeCard(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: 'pokemon-1',
    run_id: 'run-1',
    raw_import_id: 'raw-1',
    order_list_item_id: 'item-1',
    excel_product_id: 'excel-1',
    db_card_id: 'db-1',
    franchise: 'Pokemon',
    card_name: 'Pikachu',
    grade: 'PSA10',
    list_no: '001/100',
    image_url: 'https://excel.example/pikachu.jpg',
    alt_image_url: 'https://db.example/pikachu.jpg',
    rarity: 'PROMO',
    rarity_icon_url: null,
    tag: 'Pikachu/Promo',
    price_high: 95_000,
    price_low: 90_000,
    image_status: 'ok',
    source: 'order_list',
    price_source: 'order_list',
    price_source_date: '2026-07-27',
    created_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function makeItem(overrides: Partial<OrderListItemRow> = {}): OrderListItemRow {
  return {
    id: 'item-1',
    import_id: 'import-1',
    franchise: 'Pokemon',
    excel_product_id: 'excel-1',
    sheet_name: 'Pokemon',
    sheet_row_number: 2,
    row_hash: 'hash',
    card_name: 'Pikachu',
    grade: 'PSA10',
    expansion: 'Promo card pack',
    list_no: '001/100',
    rarity: 'PROMO',
    image_url: 'https://excel.example/pikachu.jpg',
    demand: 1,
    source_price: 100_000,
    raw_row: {},
    validation_issues: [],
    mapping_id: 'mapping-1',
    db_card_id: 'db-1',
    match_status: 'matched',
    match_method: 'existing_mapping',
    match_candidates: [],
    match_note: null,
    selection_fingerprint: null,
    matched_at: '2026-07-27T00:00:00.000Z',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('MANMAN buyback sheet', () => {
  it('店頭用ページだけを5商材の固定順、ページ番号の順に並べる', () => {
    const pages: PublishPage[] = [
      makePage({ franchise: 'DRAGON BALL', card_ids: ['dragon-1'] }),
      makePage({ franchise: 'ONE PIECE', card_ids: ['onepiece-1'] }),
      makePage({ franchise: 'WEISS SCHWARZ', card_ids: ['weiss-1'] }),
      makePage({ franchise: 'Pokemon', page_index: 1, card_ids: ['pokemon-2'] }),
      makePage({ franchise: 'YU-GI-OH!', card_ids: ['yugioh-1'] }),
      makePage({ franchise: 'Pokemon', page_index: 0, card_ids: ['pokemon-1'] }),
      makePage({ kind: 'postal', card_ids: ['postal-only'] }),
    ];

    expect(flattenGeneratedStorePageCardIds(pages)).toEqual([
      'pokemon-1',
      'pokemon-2',
      'yugioh-1',
      'onepiece-1',
      'weiss-1',
      'dragon-1',
    ]);
  });

  it('未完了ページがあれば公開を拒否する', () => {
    expect(() => flattenGeneratedStorePageCardIds([
      makePage({ status: 'failed' }),
    ])).toThrow('未完了の店頭用ページ');
  });

  it('店頭用ページがなければ公開を拒否する', () => {
    expect(() => flattenGeneratedStorePageCardIds([
      makePage({ kind: 'postal' }),
    ])).toThrow('店頭用生成ページがありません');
  });

  it('A:I の商品情報、買取価格、更新日を生成する', () => {
    const values = buildBuybackSheetValues({
      runId: 'run-1',
      orderedCardIds: ['pokemon-1'],
      cards: [makeCard()],
      orderListItems: [makeItem()],
      orderListImportId: 'import-1',
      businessDate: '2026-07-27',
    });

    expect(values).toEqual([
      [...BUYBACK_SHEET_HEADERS],
      [
        'excel-1',
        'Pikachu',
        'PSA10',
        'Promo card pack',
        '001/100',
        'PROMO',
        'https://excel.example/pikachu.jpg',
        95_000,
        '2026/07/27',
      ],
    ]);
  });

  it('フォールバック画像と単一タグのレアリティ補完を使う', () => {
    const values = buildBuybackSheetValues({
      runId: 'run-1',
      orderedCardIds: ['pokemon-1'],
      cards: [makeCard({ image_status: 'fallback', rarity: "'-", tag: 'SAR' })],
      orderListItems: [makeItem({ rarity: "'-" })],
      orderListImportId: 'import-1',
      businessDate: '2026-07-27',
    });

    expect(values[1][5]).toBe('SAR');
    expect(values[1][6]).toBe('https://db.example/pikachu.jpg');
  });

  it('価格日が業務日と異なる商品を拒否する', () => {
    expect(() => buildBuybackSheetValues({
      runId: 'run-1',
      orderedCardIds: ['pokemon-1'],
      cards: [makeCard({ price_source_date: '2026-07-26' })],
      orderListItems: [makeItem()],
      orderListImportId: 'import-1',
      businessDate: '2026-07-27',
    })).toThrow('価格日とオーダーリスト業務日が一致しません');
  });

  it('価格日が空の商品を拒否する', () => {
    expect(() => buildBuybackSheetValues({
      runId: 'run-1',
      orderedCardIds: ['pokemon-1'],
      cards: [makeCard({ price_source_date: null })],
      orderListItems: [makeItem()],
      orderListImportId: 'import-1',
      businessDate: '2026-07-27',
    })).toThrow('価格日とオーダーリスト業務日が一致しません');
  });

  it('別のRunに属する商品を拒否する', () => {
    expect(() => buildBuybackSheetValues({
      runId: 'run-1',
      orderedCardIds: ['pokemon-1'],
      cards: [makeCard({ run_id: 'run-older' })],
      orderListItems: [makeItem()],
      orderListImportId: 'import-1',
      businessDate: '2026-07-27',
    })).toThrow('別のRunに属する商品です');
  });
});
