import type { AssetProfileRow, LayoutConfig, PreparedCardRow } from '@haraka/shared';

const mockCompositeCalls: unknown[][] = [];

jest.mock('sharp', () => {
  return jest.fn(() => {
    const instance: Record<string, jest.Mock> = {};
    instance.resize = jest.fn(() => instance);
    instance.png = jest.fn(() => instance);
    instance.composite = jest.fn((composites: unknown[]) => {
      mockCompositeCalls.push(composites);
      return instance;
    });
    instance.toBuffer = jest.fn(async () => Buffer.from('mock-image'));
    return instance;
  });
});

import { composePage } from '../lib/image-composer';

function makeCard(overrides: Partial<PreparedCardRow> = {}): PreparedCardRow {
  return {
    id: 'card-1',
    run_id: 'run-1',
    raw_import_id: 'raw-1',
    order_list_item_id: null,
    excel_product_id: null,
    db_card_id: null,
    franchise: 'ONE PIECE',
    card_name: 'テストカード',
    grade: 'PSA10',
    list_no: 'OP00-001',
    image_url: 'https://example.com/card.png',
    alt_image_url: null,
    rarity: null,
    rarity_icon_url: null,
    tag: 'TOP',
    price_high: 28500,
    price_low: 24000,
    image_status: 'ok',
    source: 'kecak',
    price_source: 'kecak',
    price_source_date: null,
    created_at: '2026-06-06T00:00:00Z',
    ...overrides,
  };
}

const layout = {
  startX: 0,
  priceStartX: 0,
  colWidth: 100,
  cardWidth: 80,
  cardHeight: 120,
  priceBoxWidth: 120,
  priceBoxHeight: 32,
  dateX: 300,
  dateY: 300,
  rows: [{ cardY: 0, priceHighY: 140, priceLowY: 180 }],
} as LayoutConfig;

const assetProfile = {
  grid_cols: 1,
  price_format: '¥{price}',
  font_family: 'Noto Sans JP',
} as AssetProfileRow;

describe('composePage', () => {
  beforeEach(() => {
    mockCompositeCalls.length = 0;
  });

  it('1価格テンプレートでも商材別減額率を反映した price_high を表示する', async () => {
    await composePage({
      templateBuffer: Buffer.from('template'),
      cardBackBuffer: Buffer.from('back'),
      cards: [makeCard()],
      layout,
      assetProfile,
      cardImageBuffers: new Map([['card-1', Buffer.from('card-image')]]),
      dateText: '06/06',
      skipPriceLow: true,
    });

    const finalComposite = mockCompositeCalls[mockCompositeCalls.length - 1] as Array<{ input: Buffer }>;
    const svgText = finalComposite.map(item => item.input.toString('utf8')).join('\n');

    expect(svgText).toContain('¥28,500');
    expect(svgText).not.toContain('¥24,000');
  });
});
