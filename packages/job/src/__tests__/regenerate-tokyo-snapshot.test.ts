const mockCompose: jest.Mock = jest.fn(async () => Buffer.from('rendered'));
const mockLoadPrices: jest.Mock = jest.fn(async () => new Map());
const mockApplyPrices: jest.Mock = jest.fn((cards) => cards);
const mockLoadSettings: jest.Mock = jest.fn(async () => ({ box_price_low_enabled: mockBoxPriceLowEnabled }));
const mockPublish: jest.Mock = jest.fn(async () => ({ status: 'completed', rowCount: 1 }));
const mockDownload: jest.Mock = jest.fn(async () => Buffer.from('asset'));
let mockDb: unknown;
let mockDisabled = false;
let mockBoxPriceLowEnabled = false;
jest.mock('../lib/supabase', () => ({ createSupabaseClientFromSecrets: async () => mockDb }));
jest.mock('../lib/auth', () => ({ getAccessToken: async () => 'test', getBuybackSheetAccessToken: async () => 'test' }));
jest.mock('../lib/buyback-sheet', () => ({ isBuybackSheetPublishDisabled: () => mockDisabled, publishManmanBuybackSheet: (...args: unknown[]) => mockPublish(...args) }));
const mockNotify = jest.fn();
jest.mock('../lib/discord', () => ({ sendDiscordNotification: (...args: unknown[]) => mockNotify(...args), COLOR: { WARNING: 0xffaa00 } }));
jest.mock('../lib/image-composer', () => ({ composePage: (...args: unknown[]) => mockCompose(...args) }));
jest.mock('../lib/asset-storage', () => ({ downloadTemplateAsset: (...args: unknown[]) => mockDownload(...args) }));
jest.mock('../lib/google-drive', () => ({ downloadDriveFile: async () => Buffer.from('drive'), downloadImagesWithConcurrency: async () => [null] }));
jest.mock('../lib/pricing-settings', () => ({ loadStorePricingSettings: (...args: unknown[]) => mockLoadSettings(...args) }));
jest.mock('../lib/shinsoku-box-price-source', () => ({
  loadShinsokuBoxPriceMap: (...args: unknown[]) => mockLoadPrices(...args),
  applyCurrentShinsokuBoxPrices: (...args: unknown[]) => mockApplyPrices(...args),
}));

test.each([
  [false, false, false, false], [true, false, false, false], [false, true, false, false],
  [false, false, true, false], [false, false, false, true],
] as const)('Tokyo regeneration preserves prices (sheet failure=%s, save failure=%s, disabled=%s, BOX lower=%s)', async (sheetFailure, saveFailure, disabled, boxPriceLowEnabled) => {
  const originalStore = process.env.STORE_NAME;
  const originalPage = process.env.PAGE_ID;
  try {
    for (const [store, snapshot, legacy] of [
      ['manman-akihabara', 'snapshot', false], ['manman-akihabara', null, true], ['manman', 'snapshot', true],
    ] as const) {
      jest.resetModules(); jest.clearAllMocks();
      mockDisabled = disabled;
      mockBoxPriceLowEnabled = boxPriceLowEnabled;
      mockPublish.mockImplementation(async () => {
        if (sheetFailure) throw new Error('sheet boundary failed');
        return { status: 'completed', rowCount: 1 };
      });
      process.env.STORE_NAME = store; process.env.PAGE_ID = 'page';
      const layout = { rows: [], priceBoxWidth: 100, priceBoxHeight: 20, cardFit: 'contain' };
      const card = { id: 'card', run_id: 'run', card_name: '[BOX]テスト', grade: 'BOX', tag: 'BOX', price_high: 9300, price_low: 1111 };
      const page = { id: 'page', run_id: 'run', franchise: 'Pokemon', layout_template_id: 'box-layout', card_ids: ['card'], page_label: 'BOX', page_index: 0 };
      mockDb = {
        from: (table: string) => {
          let single = false, updating = false;
          const query: Record<string, unknown> = {};
          const result = () => ({ data: table === 'run' ? single ? { id: 'run', order_list_import_id: 'import', tokyo_snapshot_id: snapshot } : [{ id: 'run' }]
            : table === 'generated_page' ? page : table === 'prepared_card' ? [card]
              : table === 'order_list_import' ? { business_date: '2026-09-07' }
                : table === 'asset_profile' ? [{ layout_config: layout, total_slots: 30, template_box_storage_path: 'wrong-legacy-template' }]
                  : table === 'layout_template' ? { id: 'box-layout', franchise: 'Pokemon', slug: 'box_30', grid_cols: 6, total_slots: 30,
                    template_storage_path: 'tokyo/box_30.png', card_back_storage_path: 'tokyo/box-back.png', layout_config: layout } : null,
            error: saveFailure && updating && table === 'generated_page' ? { message: 'save boundary failed' } : null });
          for (const method of ['select', 'eq', 'in', 'limit', 'returns', 'update']) query[method] = () => query;
          query.update = () => { updating = true; return query; };
          for (const method of ['single', 'maybeSingle']) query[method] = () => { single = true; return Promise.resolve(result()); };
          query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
          return query;
        },
        storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://test.invalid/image.png' } }) }) },
      };
      const { runRegeneratePage } = await import('../jobs/regenerate-page.js');
      if (saveFailure && !legacy) {
        await expect(runRegeneratePage()).rejects.toThrow('再生成ページの保存に失敗');
        expect(mockPublish).not.toHaveBeenCalled();
        continue;
      }
      await runRegeneratePage();
      expect(mockLoadPrices).toHaveBeenCalledTimes(legacy ? 1 : 0);
      expect(mockApplyPrices).toHaveBeenCalledTimes(legacy ? 1 : 0);
      expect(mockLoadSettings).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(!legacy && disabled ? 0 : 1);
      expect(mockNotify).toHaveBeenCalledTimes(!legacy && sheetFailure ? 1 : 0);
      const rendered = (mockCompose.mock.calls as unknown[][])[0][0] as Record<string, any>;
      expect(rendered.cards[0].price_high).toBe(9300);
      expect(rendered.skipPriceLow).toBe(false);
      expect(rendered.priceLowText).toBe(store === 'manman-akihabara' && !boxPriceLowEnabled ? '-' : undefined);
      expect(rendered.cards[0].price_low).toBe(1111);
      expect(rendered.requireCardImages).toBe(!legacy);
      expect(rendered.layout).toBe(layout);
      expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: 'tokyo/box_30.png' }));
      expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: 'tokyo/box-back.png' }));
    }
  } finally {
    mockDisabled = false;
    mockBoxPriceLowEnabled = false;
    if (originalStore === undefined) delete process.env.STORE_NAME; else process.env.STORE_NAME = originalStore;
    if (originalPage === undefined) delete process.env.PAGE_ID; else process.env.PAGE_ID = originalPage;
  }
});
