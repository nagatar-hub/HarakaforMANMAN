// Independent verification: real snapshot mapping, planner, composer and PNG encoding;
// only external persistence/download/notification boundaries are in-memory substitutes.
import sharp from 'sharp';
import { FRANCHISES, normalizeStorePricingSettings, calculateBoxPriceHigh } from '@haraka/shared';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

let mockDb: any;
let mockImage: Buffer;
let mockBackground: Buffer;
let mockSheetDisabled = false;
let mockBoxPriceLowEnabled = false;
jest.mock('../lib/supabase', () => ({ createSupabaseClientFromSecrets: async () => mockDb }));
jest.mock('../lib/auth', () => ({ getAccessToken: jest.fn(async () => 'local-only'), getBuybackSheetAccessToken: jest.fn() }));
jest.mock('../lib/pricing-settings', () => ({ loadStorePricingSettings: jest.fn(async () => normalizeStorePricingSettings({
  box_price_low_enabled: mockBoxPriceLowEnabled,
})) }));
jest.mock('../lib/shinsoku-box-price-source', () => ({
  loadShinsokuBoxPriceMap: jest.fn(async () => new Map()),
  applyCurrentShinsokuBoxPrices: jest.fn((cards: unknown[]) => cards),
}));
jest.mock('../lib/asset-storage', () => ({ downloadTemplateAsset: jest.fn(async ({ storagePath }) => storagePath.endsWith('template') ? mockBackground : mockImage) }));
jest.mock('../lib/google-drive', () => ({ downloadDriveFile: jest.fn(), downloadImagesWithConcurrency: async (_: unknown, urls: unknown[]) => urls.map(() => mockImage) }));
jest.mock('../lib/google-sheets', () => ({ fetchSheetValues: jest.fn() }));
jest.mock('../lib/env', () => ({
  getOptionalEnvOrSecret: jest.fn(async () => null),
  getRequiredEnvOrSecret: jest.fn(async (name: string) => name === 'PELEKA_TOKYO_CATALOG_URL'
    ? 'https://peleka.invalid/catalog' : 'local-token'),
}));
jest.mock('../lib/peleka-catalog', () => ({
  buildTokyoPelekaCatalog: jest.fn((params: any) => ({ count: params.cards.length, productsSha256: 'local' })),
  publishTokyoPelekaCatalog: jest.fn(),
}));
jest.mock('../lib/progress', () => ({ updateProgress: jest.fn(), clearProgress: jest.fn() }));
jest.mock('../lib/buyback-sheet', () => ({ isBuybackSheetPublishDisabled: () => mockSheetDisabled, publishManmanBuybackSheet: jest.fn(async () => ({ status: 'completed', rowCount: 10 })) }));
jest.mock('../lib/discord', () => ({ sendDiscordNotification: jest.fn(), COLOR: {} }));
jest.mock('../lib/image-composer', () => {
  const actual = jest.requireActual('../lib/image-composer');
  return { ...actual, composePage: jest.fn(actual.composePage) };
});

const runId = '10000000-0000-4000-8000-000000000001';
const token = '10000000-0000-4000-8000-000000000002';

test('independent BOX lower price applies the configured rate to the selected source price', () => {
  const sourcePrice = 8500;
  const settings = normalizeStorePricingSettings({ box_discount_rates: { 'DRAGON BALL': { shrink: 0.07, no_shrink: 0.13 } } });
  const high = calculateBoxPriceHigh(sourcePrice, settings.box_discount_rates['DRAGON BALL'].shrink);
  const [row] = buildTokyoPreparedCards(runId, { snapshot: { store: 'manman-akihabara', business_date: '2026-09-07', settings }, products: [{
    id: 'independent-cap', franchise: 'DRAGON BALL', product_type: 'box', name: 'fixture BOX', model_number: null,
    image_url: null, source_price: sourcePrice, price_high: high,
  }] } as any);
  expect(high).toBe(7000);
  expect(row.price_low).toBe(7000);
});

function database(tables: Record<string, any[]>) {
  let nextId = 0;
  const uploads: { path: string; image: Buffer }[] = [];
  const bucket = {
    upload: jest.fn(async (path: string, image: Buffer) => { uploads.push({ path, image }); return { error: null }; }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://local.invalid/${path}` } }),
    list: jest.fn(async () => ({ data: [] })), remove: jest.fn(),
  };
  const db = { storage: { from: () => bucket }, from(table: string) {
    let action = 'select'; let payload: any; let orderKey: string | null = null; let range: [number, number] | null = null;
    const filters: ((row: any) => boolean)[] = [];
    const execute = () => {
      const rows = tables[table] ?? (tables[table] = []);
      let selected = rows.filter(row => filters.every(filter => filter(row)));
      if (orderKey) selected.sort((a, b) => String(a[orderKey!]).localeCompare(String(b[orderKey!])));
      if (range) selected = selected.slice(range[0], range[1] + 1);
      if (action === 'insert') {
        selected = (Array.isArray(payload) ? payload : [payload]).map((row: any) => ({ id: `row-${nextId++}`, ...row }));
        rows.push(...selected);
      } else if (action === 'update') selected.forEach(row => Object.assign(row, payload));
      else if (action === 'delete') tables[table] = rows.filter(row => !selected.includes(row));
      return { data: selected, count: selected.length, error: null };
    };
    const query: any = {
      select: () => query, order: (key: string) => { orderKey = key; return query; }, limit: () => query,
      range: (from: number, to: number) => { range = [from, to]; return query; },
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      is: (key: string, value: unknown) => { filters.push(row => (row[key] ?? null) === value); return query; },
      not: (key: string) => { filters.push(row => row[key] != null); return query; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
      insert: (value: unknown) => { action = 'insert'; payload = value; return query; },
      update: (value: unknown) => { action = 'update'; payload = value; return query; },
      delete: () => { action = 'delete'; return query; },
      returns: () => query,
      maybeSingle: async () => { const result = execute(); return { ...result, data: result.data[0] ?? null }; },
      then: (resolve: any, reject: any) => Promise.resolve(execute()).then(resolve, reject),
    };
    return query;
  } };
  return { db, uploads, bucket };
}

test.each([1000, 1001, 1045])('Tokyo prepared_card pagination loads all %i rows in stable id order', async count => {
  jest.resetModules();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `card-${String(count - index).padStart(4, '0')}`,
    run_id: runId,
    franchise: 'Pokemon',
    tag: 'PSA10',
    price_high: index + 1,
  }));
  const calls: [number, number][] = [];
  const supabase: any = { from: () => {
    let from = 0; let to = 999;
    const query: any = {
      select: () => query, eq: () => query, order: () => query,
      range: (start: number, end: number) => { from = start; to = end; calls.push([start, end]); return query; },
      returns: () => query,
      then: (resolve: any, reject: any) => Promise.resolve({
        data: [...rows].sort((a, b) => a.id.localeCompare(b.id)).slice(from, to + 1), error: null,
      }).then(resolve, reject),
    };
    return query;
  } };
  const { loadAllTokyoPreparedCards } = require('../jobs/generate');
  const actual = await loadAllTokyoPreparedCards(supabase, runId, 'Pokemon');
  expect(actual).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  expect(actual.map((card: any) => [card.tag, card.price_high])).toEqual(
    [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(card => [card.tag, card.price_high]),
  );
  expect(calls).toEqual([[0, 999], [1000, 1999]]);
});

test.each([
  ['manman-akihabara', false, false, false], ['manman', false, false, false],
  ['manman-akihabara', true, false, false], ['manman-akihabara', false, true, false],
  ['manman-akihabara', false, false, true],
] as const)('%s: real generation preserves prices (sheet failure=%s, disabled=%s, BOX lower=%s)', async (store, sheetFailure, sheetDisabled, boxPriceLowEnabled) => {
  jest.resetModules();
  const tokyo = store === 'manman-akihabara';
  const previousEnv = { STORE_NAME: process.env.STORE_NAME, RUN_ID: process.env.RUN_ID, GENERATE_CLAIM_TOKEN: process.env.GENERATE_CLAIM_TOKEN };
  process.env.STORE_NAME = store; process.env.RUN_ID = runId; process.env.GENERATE_CLAIM_TOKEN = token;
  mockBoxPriceLowEnabled = boxPriceLowEnabled;
  const { runGenerate } = require('../jobs/generate');
  mockSheetDisabled = sheetDisabled;
  const sheetPublisher = require('../lib/buyback-sheet').publishManmanBuybackSheet;
  if (sheetFailure) sheetPublisher.mockRejectedValue(new Error('sheet test failure'));
  const { composePage } = require('../lib/image-composer');
  const prices = require('../lib/shinsoku-box-price-source');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockImage = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#3488bb' } }).png().toBuffer();
  mockBackground = await sharp({ create: { width: 600, height: 800, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const products = FRANCHISES.flatMap((franchise, n) => ['psa', 'box'].map((product_type, m) => ({
    id: `source-${n}-${m}`, franchise, product_type, name: `${franchise}-${product_type}`, model_number: m ? null : `000/${n}`,
    image_url: 'https://local.invalid/card.png', source_price: 80000, price_high: m ? calculateBoxPriceHigh(80000, 0.07) : 12300 + n * 100,
  })));
  const prepared = buildTokyoPreparedCards(runId, { snapshot: { store: 'manman-akihabara', business_date: '2026-09-07', settings: normalizeStorePricingSettings({}) }, products } as any)
    .map((row, n) => ({ id: `card-${n}`, ...row }));
  if (tokyo) for (const card of prepared) if (card.grade === 'PSA10') card.tag = 'AR/SAR/selected';
  const rules = tokyo ? FRANCHISES.map(franchise => ({ id: `rule-${franchise}`, store, franchise,
    tag_pattern: 'AR/SAR', match_type: 'contains', behavior: 'group', priority: 100, group_key: '保存したタググループ' })) : [];
  const geometry = { startX: 10, priceStartX: 10, colWidth: 90, cardWidth: 50, cardHeight: 70,
    priceBoxWidth: 80, priceBoxHeight: 30, dateX: 250, dateY: 700, rows: [{ cardY: 5, priceHighY: 100, priceLowY: 130 }] };
  const layouts = FRANCHISES.flatMap(franchise => ['psa', 'box'].map(type => ({ id: `${franchise}-${type}`, franchise,
    store, kind: 'store', slug: type === 'box' ? 'box_30' : 'psa_24', is_active: true,
    total_slots: type === 'box' ? 30 : 24, grid_cols: 6, skip_price_low: true, priority: 1,
    template_storage_path: `${type}-template`, card_back_storage_path: `${type}-back`,
    layout_config: { ...geometry, rows: Array.from({ length: type === 'box' ? 5 : 4 }, (_, n) => ({ cardY: (type === 'box' ? 17 : 5) + n * 140, priceHighY: 100 + n * 140, priceLowY: 130 + n * 140 })) },
  })));
  const tables: Record<string, any[]> = { run: [{ id: runId, store, status: 'running', generate_claim_token: token,
    started_at: '2026-09-07T01:23:45.000Z',
    plan_done_at: '2026-09-07T00:00:00Z', generate_done_at: null, tokyo_snapshot_id: tokyo ? 'snapshot' : null, order_list_import_id: 'import' }],
    order_list_import: [{ id: 'import', store, business_date: tokyo ? '2026-09-06' : '2026-09-07' }],
    tokyo_buyback_snapshot: tokyo ? [{ id: 'snapshot', store, business_date: '2026-09-07' }] : [],
    prepared_card: prepared, generated_page: [], layout_template: layouts, rule: rules,
    asset_profile: FRANCHISES.map(franchise => ({ franchise, store, total_slots: 30, grid_cols: 6,
      template_box_storage_path: 'legacy-template', card_back_box_storage_path: 'legacy-back',
      price_format: '¥{price}', font_family: 'Arial', layout_config: { ...geometry,
        rowsBOX: Array.from({ length: 5 }, (_, n) => ({ cardY: 5 + n * 140, priceHighY: 100 + n * 140, priceLowY: 130 + n * 140 })) } })),
  };
  const boundary = database(tables); mockDb = boundary.db;
  try {
    await runGenerate();
    expect(tables.run[0].status).toBe('completed');
    expect(tables.run[0].generate_done_at).toBeTruthy();
    expect(tables.generated_page).toHaveLength(products.length);
    expect(tables.generated_page.every(page => page.status === 'generated' && page.run_id === runId && page.kind === 'store')).toBe(true);
    expect(tables.generated_page.flatMap(page => page.card_ids).sort()).toEqual(prepared.map(card => card.id).sort());
    if (tokyo) {
      expect(tables.generated_page.filter(page => page.page_label === '保存したタググループ')).toHaveLength(FRANCHISES.length);
      for (const card of prepared.filter(card => card.grade === 'PSA10')) {
        expect(tables.generated_page.find(page => page.card_ids.includes(card.id)).page_label).toBe('保存したタググループ');
      }
      expect(tables.rule.every(rule => rule.tag_pattern === 'AR/SAR' && rule.match_type === 'contains')).toBe(true);
    }
    expect(prices.loadShinsokuBoxPriceMap.mock.calls.length).toBe(tokyo ? 0 : 1);
    expect(prices.applyCurrentShinsokuBoxPrices.mock.calls.length).toBe(tokyo ? 0 : FRANCHISES.length);
    expect(require('../lib/auth').getAccessToken.mock.calls.length).toBe(tokyo ? 0 : 1);
    expect(require('../lib/pricing-settings').loadStorePricingSettings).toHaveBeenCalledTimes(1);
    expect(require('../lib/peleka-catalog').publishTokyoPelekaCatalog.mock.calls.length).toBe(tokyo ? 1 : 0);
    expect(sheetPublisher).toHaveBeenCalledTimes(sheetDisabled ? 0 : 1);
    if (!sheetDisabled) expect(sheetPublisher).toHaveBeenCalledWith(expect.objectContaining({ runId, supabase: mockDb }));
    expect(require('../lib/auth').getBuybackSheetAccessToken).toHaveBeenCalledTimes(sheetDisabled ? 0 : 1);
    if (sheetFailure) expect(require('../lib/discord').sendDiscordNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('一部失敗あり'), fields: expect.arrayContaining([
        { name: 'Google Sheet', value: 'sheet test failure', inline: false },
      ]) }),
    );
    if (tokyo) expect(require('../lib/peleka-catalog').buildTokyoPelekaCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ businessDate: '2026-09-07', generatedAt: '2026-09-07T01:23:45.000Z' }),
    );
    expect(boundary.bucket.remove).not.toHaveBeenCalled();
    for (const [index, [params]] of composePage.mock.calls.entries()) {
      const card = params.cards[0];
      expect(params.dateText).toBe('09/07');
      expect(params.skipPriceLow).toBe(card.tag !== 'BOX');
      expect(params.priceLowText).toBe(tokyo && card.tag === 'BOX' && !boxPriceLowEnabled ? '-' : undefined);
      expect(card.price_high).toBe(products.find(product => product.id === card.source_shinsoku_id)!.price_high);
      if (card.tag === 'BOX') {
        expect(params.layout.rows[0].cardY).toBe(tokyo ? 17 : 24);
        expect(params.layout.rows[0].priceLowY - params.layout.rows[0].priceHighY).toBe(30);
        expect(card.price_low).toBe(['DRAGON BALL', 'WEISS SCHWARZ'].includes(card.franchise) ? 69000 : 68000);
        const png = await composePage.mock.results[index].value;
        const pixels = await sharp(png).extract({ left: 0, top: tokyo ? 130 : 114, width: 100, height: 30 }).removeAlpha().raw().toBuffer();
        let bluePixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 3) {
          if (pixels[offset + 2] > pixels[offset] + 40 && pixels[offset + 2] > pixels[offset + 1] + 20) bluePixels++;
        }
        expect(bluePixels).toBeGreaterThan(5);
      }
      expect(params.totalSlots).toBe(card.tag === 'BOX' ? 30 : 24);
    }
    expect(boundary.uploads).toHaveLength(products.length);
    for (const upload of boundary.uploads) {
      expect(upload.path).toContain(`generated/${store}/`);
      expect((await sharp(upload.image).metadata()).format).toBe('png');
    }
  } finally {
    mockSheetDisabled = false;
    mockBoxPriceLowEnabled = false;
    quiet.mockRestore();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
