// Independent verification: real snapshot mapping, planner, composer and PNG encoding;
// only external persistence/download/notification boundaries are in-memory substitutes.
import sharp from 'sharp';
import { FRANCHISES, normalizeStorePricingSettings } from '@haraka/shared';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

let mockDb: any;
let mockImage: Buffer;
let mockBackground: Buffer;
jest.mock('../lib/supabase', () => ({ createSupabaseClientFromSecrets: async () => mockDb }));
jest.mock('../lib/auth', () => ({ getAccessToken: jest.fn(async () => 'local-only'), getBuybackSheetAccessToken: jest.fn() }));
jest.mock('../lib/pricing-settings', () => ({ loadStorePricingSettings: jest.fn(async () => normalizeStorePricingSettings({})) }));
jest.mock('../lib/shinsoku-box-price-source', () => ({
  loadShinsokuBoxPriceMap: jest.fn(async () => new Map()),
  applyCurrentShinsokuBoxPrices: jest.fn((cards: unknown[]) => cards),
}));
jest.mock('../lib/asset-storage', () => ({ downloadTemplateAsset: jest.fn(async ({ storagePath }) => storagePath.endsWith('template') ? mockBackground : mockImage) }));
jest.mock('../lib/google-drive', () => ({ downloadDriveFile: jest.fn(), downloadImagesWithConcurrency: async (_: unknown, urls: unknown[]) => urls.map(() => mockImage) }));
jest.mock('../lib/google-sheets', () => ({ fetchSheetValues: jest.fn() }));
jest.mock('../lib/env', () => ({ getOptionalEnvOrSecret: jest.fn(async () => null) }));
jest.mock('../lib/progress', () => ({ updateProgress: jest.fn(), clearProgress: jest.fn() }));
jest.mock('../lib/buyback-sheet', () => ({ isBuybackSheetPublishDisabled: () => true, publishManmanBuybackSheet: jest.fn() }));
jest.mock('../lib/discord', () => ({ sendDiscordNotification: jest.fn(), COLOR: {} }));
jest.mock('../lib/image-composer', () => {
  const actual = jest.requireActual('../lib/image-composer');
  return { ...actual, composePage: jest.fn(actual.composePage) };
});

const runId = '10000000-0000-4000-8000-000000000001';
const token = '10000000-0000-4000-8000-000000000002';

function database(tables: Record<string, any[]>) {
  let nextId = 0;
  const uploads: { path: string; image: Buffer }[] = [];
  const bucket = {
    upload: jest.fn(async (path: string, image: Buffer) => { uploads.push({ path, image }); return { error: null }; }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://local.invalid/${path}` } }),
    list: jest.fn(async () => ({ data: [] })), remove: jest.fn(),
  };
  const db = { storage: { from: () => bucket }, from(table: string) {
    let action = 'select'; let payload: any; const filters: ((row: any) => boolean)[] = [];
    const execute = () => {
      const rows = tables[table] ?? (tables[table] = []);
      let selected = rows.filter(row => filters.every(filter => filter(row)));
      if (action === 'insert') {
        selected = (Array.isArray(payload) ? payload : [payload]).map((row: any) => ({ id: `row-${nextId++}`, ...row }));
        rows.push(...selected);
      } else if (action === 'update') selected.forEach(row => Object.assign(row, payload));
      else if (action === 'delete') tables[table] = rows.filter(row => !selected.includes(row));
      return { data: selected, count: selected.length, error: null };
    };
    const query: any = {
      select: () => query, order: () => query, limit: () => query,
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

test.each(['manman-akihabara', 'manman'])('%s: real normal generation preserves Tokyo snapshot prices without changing legacy branches', async store => {
  jest.resetModules();
  const tokyo = store === 'manman-akihabara';
  const previousEnv = { STORE_NAME: process.env.STORE_NAME, RUN_ID: process.env.RUN_ID, GENERATE_CLAIM_TOKEN: process.env.GENERATE_CLAIM_TOKEN };
  process.env.STORE_NAME = store; process.env.RUN_ID = runId; process.env.GENERATE_CLAIM_TOKEN = token;
  const { runGenerate } = require('../jobs/generate');
  const { composePage } = require('../lib/image-composer');
  const prices = require('../lib/shinsoku-box-price-source');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockImage = await sharp({ create: { width: 80, height: 100, channels: 4, background: '#3488bb' } }).png().toBuffer();
  mockBackground = await sharp({ create: { width: 600, height: 800, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const products = FRANCHISES.flatMap((franchise, n) => ['psa', 'box'].map((product_type, m) => ({
    id: `source-${n}-${m}`, franchise, product_type, name: `${franchise}-${product_type}`, model_number: m ? null : `000/${n}`,
    image_url: 'https://local.invalid/card.png', source_price: 80000, price_high: 12300 + n * 100 + m * 1000,
  })));
  const prepared = buildTokyoPreparedCards(runId, { snapshot: { store: 'manman-akihabara', business_date: '2026-09-07' }, products } as any)
    .map((row, n) => ({ id: `card-${n}`, ...row }));
  const geometry = { startX: 10, priceStartX: 10, colWidth: 90, cardWidth: 50, cardHeight: 70,
    priceBoxWidth: 80, priceBoxHeight: 30, dateX: 250, dateY: 700, rows: [{ cardY: 5, priceHighY: 100, priceLowY: 100 }] };
  const layouts = FRANCHISES.flatMap(franchise => ['psa', 'box'].map(type => ({ id: `${franchise}-${type}`, franchise,
    store, kind: 'store', slug: type === 'box' ? 'box_30' : 'psa_24', is_active: true,
    total_slots: type === 'box' ? 30 : 24, grid_cols: 6, skip_price_low: true, priority: 1,
    template_storage_path: `${type}-template`, card_back_storage_path: `${type}-back`,
    layout_config: { ...geometry, rows: Array.from({ length: type === 'box' ? 5 : 4 }, (_, n) => ({ cardY: (type === 'box' ? 17 : 5) + n * 140, priceHighY: 100 + n * 140, priceLowY: 100 + n * 140 })) },
  })));
  const tables: Record<string, any[]> = { run: [{ id: runId, store, status: 'running', generate_claim_token: token,
    plan_done_at: '2026-09-07T00:00:00Z', generate_done_at: null, tokyo_snapshot_id: tokyo ? 'snapshot' : null, order_list_import_id: 'import' }],
    order_list_import: [{ id: 'import', store, business_date: '2026-09-07' }],
    prepared_card: prepared, generated_page: [], layout_template: layouts, rule: [],
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
    expect(prices.loadShinsokuBoxPriceMap.mock.calls.length).toBe(tokyo ? 0 : 1);
    expect(prices.applyCurrentShinsokuBoxPrices.mock.calls.length).toBe(tokyo ? 0 : FRANCHISES.length);
    expect(require('../lib/auth').getAccessToken.mock.calls.length).toBe(tokyo ? 0 : 1);
    expect(require('../lib/pricing-settings').loadStorePricingSettings.mock.calls.length).toBe(tokyo ? 0 : 1);
    expect(boundary.bucket.remove).not.toHaveBeenCalled();
    for (const [params] of composePage.mock.calls) {
      const card = params.cards[0];
      expect(params.skipPriceLow).toBe(tokyo || card.tag !== 'BOX');
      expect(card.price_high).toBe(products.find(product => product.id === card.source_shinsoku_id)!.price_high);
      if (card.tag === 'BOX') expect(params.layout.rows[0].cardY).toBe(tokyo ? 17 : 24);
      expect(params.totalSlots).toBe(card.tag === 'BOX' ? 30 : 24);
    }
    expect(boundary.uploads).toHaveLength(products.length);
    for (const upload of boundary.uploads) {
      expect(upload.path).toContain(`generated/${store}/`);
      expect((await sharp(upload.image).metadata()).format).toBe('png');
    }
  } finally {
    quiet.mockRestore();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
