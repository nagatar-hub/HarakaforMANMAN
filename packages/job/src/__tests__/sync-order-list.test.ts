import type { Database } from '@haraka/shared';
import {
  buildOrderListRawImports,
  fetchAllMatchedOrderListItems,
  runSync,
} from '../jobs/sync';

type OrderListItemRow = Database['public']['Tables']['order_list_item']['Row'];

function makeItem(overrides: Partial<OrderListItemRow> = {}): OrderListItemRow {
  return {
    id: 'item-1',
    import_id: 'import-1',
    franchise: 'Pokemon',
    excel_product_id: 'excel-1',
    sheet_name: 'ポケモン',
    sheet_row_number: 2,
    row_hash: 'a'.repeat(64),
    card_name: 'リザードン',
    grade: 'PSA10',
    expansion: '拡張パック',
    list_no: '001',
    rarity: 'SAR',
    image_url: 'https://excel.example/card.jpg',
    demand: 3,
    source_price: 50_000,
    raw_row: { 商品ID: 'excel-1' },
    validation_issues: [],
    mapping_id: 'mapping-1',
    db_card_id: 'db-1',
    match_status: 'matched',
    match_method: 'existing_mapping',
    match_candidates: [],
    match_note: null,
    matched_at: '2026-07-14T00:00:00.000Z',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('order-list sync helpers', () => {
  const originalImportId = process.env.ORDER_LIST_IMPORT_ID;

  afterEach(() => {
    if (originalImportId === undefined) {
      delete process.env.ORDER_LIST_IMPORT_ID;
    } else {
      process.env.ORDER_LIST_IMPORT_ID = originalImportId;
    }
  });

  it('ORDER_LIST_IMPORT_ID がなければDBへ接続する前に拒否する', async () => {
    delete process.env.ORDER_LIST_IMPORT_ID;

    await expect(runSync()).rejects.toThrow('ORDER_LIST_IMPORT_ID is required');
  });

  it('照合済み行を監査項目付き raw_import に変換する', () => {
    const result = buildOrderListRawImports([makeItem()], 'run-1');

    expect(result).toEqual([expect.objectContaining({
      run_id: 'run-1',
      order_list_item_id: 'item-1',
      excel_product_id: 'excel-1',
      db_card_id: 'db-1',
      source_price: 50_000,
      price_source: 'order_list',
      kecak_price: null,
      image_url: 'https://excel.example/card.jpg',
    })]);
  });

  it('Supabaseの1000件上限を越えて全照合済み行をページング取得する', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => makeItem({
      id: `item-${String(index + 1).padStart(4, '0')}`,
      excel_product_id: `excel-${index + 1}`,
      sheet_row_number: index + 2,
    }));
    const ranges: Array<[number, number]> = [];
    const eqCalls: Array<[string, unknown]> = [];
    const from = jest.fn(() => {
      const builder: Record<string, jest.Mock> = {};
      builder.select = jest.fn(() => builder);
      builder.eq = jest.fn((column: string, value: unknown) => {
        eqCalls.push([column, value]);
        return builder;
      });
      builder.order = jest.fn(() => builder);
      builder.range = jest.fn((start: number, end: number) => {
        ranges.push([start, end]);
        return {
          returns: jest.fn().mockResolvedValue({
            data: rows.slice(start, end + 1),
            error: null,
          }),
        };
      });
      return builder;
    });

    const result = await fetchAllMatchedOrderListItems(
      { from } as never,
      'import-1',
    );

    expect(result).toHaveLength(1001);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(from).toHaveBeenCalledWith('order_list_item');
    expect(eqCalls).toEqual([
      ['import_id', 'import-1'],
      ['match_status', 'matched'],
      ['import_id', 'import-1'],
      ['match_status', 'matched'],
    ]);
  });
});
