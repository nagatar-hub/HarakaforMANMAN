import type { PreparedCardRow } from '@haraka/shared';
import { buildTokyoBuybackSheetValues, publishManmanBuybackSheet } from '../lib/buyback-sheet';
import { replaceSheetValues } from '../lib/google-sheets';
import { loadShinsokuBoxPriceMap, applyCurrentShinsokuBoxPrices } from '../lib/shinsoku-box-price-source';

jest.mock('../lib/store', () => ({ STORE_NAME: 'manman-akihabara' }));
jest.mock('../lib/google-sheets', () => ({ replaceSheetValues: jest.fn(async () => undefined) }));
jest.mock('../lib/shinsoku-box-price-source', () => ({ loadShinsokuBoxPriceMap: jest.fn(), applyCurrentShinsokuBoxPrices: jest.fn() }));

const card = (id: string, source: string): PreparedCardRow => ({ id, run_id: 'run', source_shinsoku_id: source,
  franchise: 'Pokemon', card_name: id, grade: 'PSA10', price_high: 12300, price_source_date: '2026-09-10',
  image_url: 'https://example.com/card.png', image_status: 'ok', list_no: '001', rarity: null,
} as PreparedCardRow);
const params = () => ({ runId: 'run', snapshotId: 'snapshot', importId: 'import', businessDate: '2026-09-10',
  orderedCardIds: ['a', 'b'], cards: [card('a', 'postal-1'), card('b', 'kecak:new')],
  products: [{ id: 'postal-1', snapshot_id: 'snapshot', franchise: 'Pokemon', origins: [{ source: 'kecak', id: 'excel-1' }] },
    { id: 'kecak:new', snapshot_id: 'snapshot', franchise: 'Pokemon', origins: [{ source: 'kecak', id: 'new' }] }],
  orderListItems: [{ id: 'row', import_id: 'import', franchise: 'Pokemon' as const, excel_product_id: 'excel-1',
    card_name: 'old name', grade: 'PSA10', expansion: 'PROMO', list_no: '001', rarity: 'SR' }],
});

describe('Tokyo snapshot sheet', () => {
  const env = { ...process.env };
  beforeEach(() => { jest.clearAllMocks(); process.env.BUYBACK_SPREADSHEET_ID = 'tokyo-sheet'; delete process.env.BUYBACK_SHEET_PUBLISH_DISABLED; });
  afterAll(() => { process.env = env; });

  it('keeps exact Excel IDs, new source IDs, generated names/prices and nine columns', () => {
    const values = buildTokyoBuybackSheetValues(params());
    expect(values[1]).toEqual(['excel-1', 'a', 'PSA10', 'PROMO', '001', 'SR', 'https://example.com/card.png', 12300, '2026/09/10']);
    expect(values[2][0]).toBe('kecak:new');
    expect(values[2][3]).toBe('');
    expect(values.every(row => row.length === 9)).toBe(true);
  });

  it.each(['empty', 'price', 'date', 'snapshot', 'run', 'ambiguous', 'duplicate', 'foreignImport'])('rejects %s before writing', kind => {
    const p = params();
    if (kind === 'empty') p.orderedCardIds = [];
    if (kind === 'price') p.cards[0].price_high = 0;
    if (kind === 'date') p.cards[0].price_source_date = '2026-09-09';
    if (kind === 'snapshot') p.products[0].snapshot_id = 'other';
    if (kind === 'run') p.cards[0].run_id = 'other';
    if (kind === 'ambiguous') p.products[0].origins.push({ source: 'kecak', id: 'other' });
    if (kind === 'duplicate') p.orderListItems.push({ ...p.orderListItems[0] });
    if (kind === 'foreignImport') p.orderListItems[0].import_id = 'other';
    expect(() => buildTokyoBuybackSheetValues(p)).toThrow();
    expect(replaceSheetValues).not.toHaveBeenCalled();
  });

  it('rejects duplicate source IDs and collisions between Excel and new IDs', () => {
    const duplicate = params();
    duplicate.cards[1].source_shinsoku_id = 'postal-1';
    expect(() => buildTokyoBuybackSheetValues(duplicate)).toThrow('重複');
    const collision = params();
    collision.cards[1].source_shinsoku_id = 'excel-1';
    collision.products[1].id = 'excel-1';
    expect(() => buildTokyoBuybackSheetValues(collision)).toThrow('出力商品IDが重複');
  });

  function db(stale = false, failed = false) {
    const p = params(); let latestReads = 0;
    const calls: string[] = [];
    return { calls, from: jest.fn((table: string) => {
      calls.push(table); let single = false;
      const result = () => {
        if (table === 'run') return { data: single
          ? { id: 'run', store: 'manman-akihabara', order_list_import_id: 'import', tokyo_snapshot_id: 'snapshot' }
          : { id: ++latestReads > 1 && stale ? 'new-run' : 'run' }, error: null };
        const data: Record<string, unknown> = {
          order_list_import: { id: 'import', store: 'manman-akihabara', business_date: '2026-09-09' },
          generated_page: [{ franchise: 'Pokemon', page_index: 0, kind: 'store', status: failed ? 'failed' : 'generated', card_ids: ['a', 'b'] }],
          tokyo_buyback_snapshot: { id: 'snapshot', store: 'manman-akihabara', order_list_import_id: 'import', business_date: p.businessDate },
          prepared_card: p.cards, tokyo_buyback_product: p.products, order_list_item: p.orderListItems,
        };
        return { data: data[table], error: null };
      };
      const q: any = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
      for (const key of ['select', 'eq', 'order', 'limit', 'not', 'in', 'range', 'returns']) q[key] = () => q;
      q.maybeSingle = () => q; q.single = () => { single = true; return q; }; return q;
    }) };
  }

  it('publisher uses fixed Tokyo prices without postal fetch or BOX recalculation', async () => {
    const supabase = db();
    const result = await publishManmanBuybackSheet({ supabase: supabase as never, runId: 'run', accessToken: 'test' });
    expect(result).toMatchObject({ status: 'completed', rowCount: 2, spreadsheetId: 'tokyo-sheet' });
    expect(replaceSheetValues).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: 'tokyo-sheet', sheetId: 0, columnCount: 9,
      values: buildTokyoBuybackSheetValues(params()) }));
    expect(loadShinsokuBoxPriceMap).not.toHaveBeenCalled();
    expect(applyCurrentShinsokuBoxPrices).not.toHaveBeenCalled();
  });

  it('does not overwrite when a newer run appears during collection', async () => {
    expect(await publishManmanBuybackSheet({ supabase: db(true) as never, runId: 'run', accessToken: 'test' })).toMatchObject({ status: 'skipped' });
    expect(replaceSheetValues).not.toHaveBeenCalled();
  });

  it('rejects failed pages and a missing Tokyo destination without writing', async () => {
    await expect(publishManmanBuybackSheet({ supabase: db(false, true) as never, runId: 'run', accessToken: 'test' })).rejects.toThrow('未完了');
    delete process.env.BUYBACK_SPREADSHEET_ID;
    await expect(publishManmanBuybackSheet({ supabase: db() as never, runId: 'run', accessToken: 'test' })).rejects.toThrow('未設定');
    expect(replaceSheetValues).not.toHaveBeenCalled();
  });
});
