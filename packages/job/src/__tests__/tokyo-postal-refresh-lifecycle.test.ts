export {};

const mockCompose: jest.Mock = jest.fn(async () => Buffer.from('rendered'));
const mockCatalogPublish: jest.Mock = jest.fn();
const mockPostalFetch: jest.Mock = jest.fn();
const mockRenderPostal: jest.Mock = jest.fn();
let db: any;

jest.mock('../lib/supabase', () => ({ createSupabaseClientFromSecrets: async () => db }));
jest.mock('../lib/auth', () => ({ getAccessToken: async () => 'token', getBuybackSheetAccessToken: async () => 'token' }));
jest.mock('../lib/buyback-sheet', () => ({
  isBuybackSheetPublishDisabled: () => false,
  publishManmanBuybackSheet: async () => ({ status: 'completed', rowCount: 2 }),
}));
jest.mock('../lib/discord', () => ({ sendDiscordNotification: jest.fn(), COLOR: { WARNING: 0xffaa00 } }));
jest.mock('../lib/image-composer', () => ({ composePage: (...args: unknown[]) => mockCompose(...args) }));
jest.mock('../lib/asset-storage', () => ({ downloadTemplateAsset: async () => Buffer.from('asset') }));
jest.mock('../lib/google-drive', () => ({
  downloadDriveFile: async () => Buffer.from('asset'),
  downloadImagesWithConcurrency: async (_token: string, urls: unknown[]) => urls.map(() => null),
}));
jest.mock('../lib/pricing-settings', () => ({ loadStorePricingSettings: async () => ({ box_price_low_enabled: false }) }));
jest.mock('../lib/shinsoku-box-price-source', () => ({
  loadShinsokuBoxPriceMap: async () => new Map(), applyCurrentShinsokuBoxPrices: (cards: unknown) => cards,
}));
jest.mock('../lib/env', () => ({ getRequiredEnvOrSecret: async (name: string) => name.includes('URL')
  ? 'https://peleka.invalid/catalog' : 'token' }));
jest.mock('../lib/peleka-catalog', () => ({
  publishCurrentTokyoPelekaCatalog: (...args: unknown[]) => mockCatalogPublish(...args),
}));
jest.mock('../lib/peleka-postal', () => {
  const actual = jest.requireActual('../lib/peleka-postal');
  return { ...actual, fetchTokyoPelekaPostalSnapshot: (...args: unknown[]) => mockPostalFetch(...args) };
});
jest.mock('../lib/tokyo-peleka-postal-render', () => ({
  stampPostalIdentifier: async (image: Buffer) => image,
  renderTokyoPelekaPostalPages: (...args: unknown[]) => mockRenderPostal(...args),
}));

const runId = '10000000-0000-4000-8000-000000000001';
const snapshotId = '20000000-0000-4000-8000-000000000001';
const requestId = '30000000-0000-4000-8000-000000000001';
const layout = { rows: [], priceBoxWidth: 100, priceBoxHeight: 20, cardFit: 'contain' };

test('store regeneration publishes r2, then the same-run refresh replaces every postal page with r2 Peleka prices', async () => {
  const original = { store: process.env.STORE_NAME, page: process.env.PAGE_ID,
    run: process.env.RUN_ID, request: process.env.POSTAL_REFRESH_REQUEST_ID };
  process.env.STORE_NAME = 'manman-akihabara';
  process.env.PAGE_ID = '40000000-0000-4000-8000-000000000001';
  process.env.RUN_ID = runId;
  process.env.POSTAL_REFRESH_REQUEST_ID = requestId;
  const cards = [
    { id: '50000000-0000-4000-8000-000000000001', run_id: runId, source_shinsoku_id: 'source-1',
      franchise: 'Pokemon', card_name: 'カード1', grade: 'PSA10', list_no: '001', tag: 'PSA10',
      image_url: 'https://store.invalid/1.png', alt_image_url: null, price_high: 1100, price_low: 900 },
    { id: '50000000-0000-4000-8000-000000000002', run_id: runId, source_shinsoku_id: 'source-2',
      franchise: 'Pokemon', card_name: 'カード2', grade: 'PSA10', list_no: '002', tag: 'PSA10',
      image_url: 'https://store.invalid/2.png', alt_image_url: null, price_high: 2100, price_low: 1700 },
  ];
  const storePage = { id: process.env.PAGE_ID, run_id: runId, franchise: 'Pokemon', kind: 'store',
    status: 'generated', layout_template_id: 'layout', card_ids: cards.map(card => card.id), page_label: 'PSA10',
    page_index: 0, image_key: null, image_url: 'https://store.invalid/original.png' };
  const r1 = { schemaVersion: 1, store: 'manman-akihabara', runId, snapshotId, revision: 1,
    businessDate: '2026-10-06', generatedAt: '2026-10-06T01:00:00Z', buyPriceDisplayMode: 'RANGE',
    boxBuybackEnabled: false, fingerprint: '1'.repeat(32), products: cards.map((card, index) => ({
      sourceId: card.source_shinsoku_id, franchise: 'Pokemon', productType: 'PSA10', name: card.card_name,
      modelNumber: card.list_no, imageUrl: `https://peleka.invalid/r1-${index}.png`, priceHigh: 500 + index * 100,
      priceLow: 400 + index * 100,
    })) };
  const postalPages = r1.products.map((product, index) => ({
    id: `60000000-0000-4000-8000-00000000000${index + 1}`, run_id: runId, franchise: 'Pokemon', kind: 'postal',
    status: 'generated', page_index: index, page_label: 'PSA10', layout_template_id: 'layout',
    card_ids: [cards[index].id], image_key: `r1-${index}.png`, image_url: `https://images.invalid/r1-${index}.png`,
    peleka_snapshot: { ...r1, products: [product] },
  }));
  const run = { id: runId, store: 'manman-akihabara', status: 'completed', generate_done_at: '2026-10-06T02:00:00Z',
    order_list_import_id: 'import', tokyo_snapshot_id: snapshotId };
  const tables: Record<string, any[]> = {
    run: [run], generated_page: [storePage, ...postalPages], prepared_card: cards,
    order_list_import: [{ id: 'import', store: 'manman-akihabara', business_date: '2026-10-06' }],
    asset_profile: [{ store: 'manman-akihabara', franchise: 'Pokemon', layout_config: layout, total_slots: 24 }],
    layout_template: [{ id: 'layout', store: 'manman-akihabara', franchise: 'Pokemon', slug: 'psa_24',
      grid_cols: 6, total_slots: 24, template_storage_path: 'template', card_back_storage_path: 'back', layout_config: layout }],
    tokyo_buyback_snapshot: [{ id: snapshotId, store: 'manman-akihabara', business_date: '2026-10-06' }],
    tokyo_peleka_catalog_revisions: [{ run_id: runId, last_revision: 1 }],
    tokyo_peleka_postal_refresh: [{ run_id: runId, request_id: requestId, status: 'running' }],
  };
  const rpc = jest.fn(async (name: string, args: any) => {
    if (name === 'replace_tokyo_peleka_postal_pages') {
      tables.generated_page = [storePage, ...args.p_pages];
      tables.tokyo_peleka_postal_refresh[0] = { run_id: runId, request_id: requestId,
        status: 'succeeded', revision: args.p_expected_revision, page_count: args.p_pages.length };
    }
    return { error: null };
  });
  db = { rpc, from(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    let updateValue: Record<string, unknown> | null = null;
    const selected = () => (tables[table] ?? []).filter(row => filters.every(filter => filter(row)));
    const result = () => {
      if (updateValue) selected().forEach(row => Object.assign(row, updateValue));
      return { data: selected(), error: null };
    };
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
      limit: () => query,
      returns: () => query,
      update: (value: Record<string, unknown>) => { updateValue = value; return query; },
      single: async () => { const value = result(); return { data: value.data[0] ?? null, error: null }; },
      maybeSingle: async () => { const value = result(); return { data: value.data[0] ?? null, error: null }; },
      then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
    };
    return query;
  }, storage: { from: () => ({ upload: async () => ({ error: null }),
    getPublicUrl: () => ({ data: { publicUrl: 'https://store.invalid/regenerated.png' } }) }) } };

  let activeSnapshot: any = r1;
  mockCatalogPublish.mockImplementation(async (_db, publishedRunId) => {
    expect(publishedRunId).toBe(runId);
    activeSnapshot = { ...r1, revision: 2, fingerprint: '2'.repeat(32), generatedAt: '2026-10-06T03:00:00Z',
      products: [
        { ...r1.products[0], imageUrl: 'https://peleka.invalid/r2-1.png', priceHigh: 700, priceLow: 600 },
        { ...r1.products[1], imageUrl: 'https://peleka.invalid/r2-2.png', priceHigh: 900, priceLow: 750 },
      ] };
    tables.tokyo_peleka_catalog_revisions[0].last_revision = 2;
    return { revision: 2, count: 2, productsSha256: 'r2-active' };
  });
  mockPostalFetch.mockImplementation(async (_url, _token, expected) => {
    expect(expected).toEqual({ runId, revision: 2 });
    return activeSnapshot;
  });
  mockRenderPostal.mockImplementation(async ({ snapshot, preparedCards, publishTogether }) => {
    expect(snapshot.products.map((product: any) => [product.sourceId, product.priceHigh, product.priceLow])).toEqual([
      ['source-1', 700, 600], ['source-2', 900, 750],
    ]);
    expect(preparedCards).toEqual(cards);
    const pages = snapshot.products.map((product: any, index: number) => ({
      id: `70000000-0000-4000-8000-00000000000${index + 1}`, run_id: runId, franchise: 'Pokemon',
      kind: 'postal', status: 'generated', page_index: index, page_label: 'PSA10', layout_template_id: 'layout',
      card_ids: [cards[index].id], image_key: `r2-${index}.png`, image_url: `https://images.invalid/r2-${index}.png`,
      peleka_snapshot: { ...snapshot, products: [product] },
    }));
    await publishTogether(pages);
    return pages.length;
  });

  try {
    jest.resetModules();
    const { runRegeneratePage } = await import('../jobs/regenerate-page.js');
    await runRegeneratePage();
    expect(mockCatalogPublish).toHaveBeenCalledTimes(1);
    const preparedBeforeRefresh = JSON.stringify(cards);
    const storeBeforeRefresh = JSON.stringify(storePage);

    const { runRefreshPelekaPostal } = await import('../jobs/refresh-peleka-postal.js');
    await runRefreshPelekaPostal();
    expect(mockPostalFetch).toHaveBeenCalledTimes(2);
    expect(mockRenderPostal).toHaveBeenCalledTimes(1);
    const refreshedPostal = tables.generated_page.filter(page => page.kind === 'postal');
    expect(refreshedPostal).toHaveLength(2);
    expect(refreshedPostal.map(page => ({ revision: page.peleka_snapshot.revision,
      sourceId: page.peleka_snapshot.products[0].sourceId,
      priceHigh: page.peleka_snapshot.products[0].priceHigh,
      priceLow: page.peleka_snapshot.products[0].priceLow }))).toEqual([
      { revision: 2, sourceId: 'source-1', priceHigh: 700, priceLow: 600 },
      { revision: 2, sourceId: 'source-2', priceHigh: 900, priceLow: 750 },
    ]);
    expect(JSON.stringify(storePage)).toBe(storeBeforeRefresh);
    expect(JSON.stringify(cards)).toBe(preparedBeforeRefresh);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      const env = key === 'store' ? 'STORE_NAME' : key === 'page' ? 'PAGE_ID'
        : key === 'run' ? 'RUN_ID' : 'POSTAL_REFRESH_REQUEST_ID';
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});
