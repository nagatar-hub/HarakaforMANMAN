import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { downloadImagesWithConcurrency } from '../lib/google-drive';
import { composePage } from '../lib/image-composer';
import { renderTokyoPelekaPostalPages } from '../lib/tokyo-peleka-postal-render';

let template: Buffer;
let cardBack: Buffer;

jest.mock('../lib/asset-storage', () => ({
  downloadTemplateAsset: jest.fn(async ({ storagePath }) => storagePath === 'template' ? template : cardBack),
}));
jest.mock('../lib/google-drive', () => ({ downloadImagesWithConcurrency: jest.fn() }));
jest.mock('../lib/image-composer', () => {
  const actual = jest.requireActual('../lib/image-composer');
  return { ...actual, composePage: jest.fn(actual.composePage) };
});

const runId = '10000000-0000-4000-8000-000000000001';
const snapshotId = '20000000-0000-4000-8000-000000000001';
const cards = [
  { id: 'card-1', run_id: runId, source_shinsoku_id: 'source-1', franchise: 'Pokemon',
    card_name: 'カード1', grade: 'PSA10', list_no: '001', tag: 'PSA10',
    image_url: 'https://store.invalid/1.png', alt_image_url: null, price_high: 1100, price_low: 900 },
  { id: 'card-2', run_id: runId, source_shinsoku_id: 'source-2', franchise: 'Pokemon',
    card_name: 'カード2', grade: 'PSA10', list_no: '002', tag: 'PSA10',
    image_url: 'https://store.invalid/2.png', alt_image_url: null, price_high: 2100, price_low: 1700 },
] as any[];
const snapshot = {
  schemaVersion: 1, store: 'manman-akihabara', runId, snapshotId, revision: 7,
  businessDate: '2026-10-06', generatedAt: '2026-10-06T01:00:00.000Z',
  buyPriceDisplayMode: 'RANGE', boxBuybackEnabled: false, fingerprint: 'a'.repeat(32),
  products: cards.map((card, index) => ({
    sourceId: card.source_shinsoku_id, franchise: 'Pokemon', productType: 'PSA10',
    name: card.card_name, modelNumber: card.list_no, imageUrl: `https://postal.invalid/${index + 1}.png`,
    priceHigh: 12300 + index * 100, priceLow: 9800 + index * 100,
  })),
} as any;

const sourceImageCacheKey = (imageUrl: string) => `cached/tokyo-postal-source-images/v1/${
  createHash('sha256').update(imageUrl, 'utf8').digest('hex')}.bin`;

function boundary(sourceImageCache: ReadonlyMap<string, Buffer> = new Map()) {
  const uploads: Buffer[] = [];
  const profile = { store: 'manman-akihabara', franchise: 'Pokemon', grid_cols: 2,
    price_format: '¥{price}', font_family: 'Arial' };
  const layout = { id: 'layout', store: 'manman-akihabara', franchise: 'Pokemon', kind: 'postal',
    slug: 'psa_2', is_active: true, priority: 1, total_slots: 2, grid_cols: 2,
    template_storage_path: 'template', card_back_storage_path: 'back',
    layout_config: { startX: 20, priceStartX: 20, colWidth: 100, cardWidth: 70, cardHeight: 90,
      rows: [{ cardY: 100, priceHighY: 200, priceLowY: 230 }], priceBoxWidth: 90,
      priceBoxHeight: 28, dateX: 760, dateY: 520 } };
  const rows: Record<string, unknown[]> = { asset_profile: [profile], layout_template: [layout], rule: [] };
  const download = jest.fn(async (path: string) => {
    const bytes = sourceImageCache.get(path);
    return bytes
      ? { data: new Blob([new Uint8Array(bytes)]), error: null }
      : { data: null, error: { message: 'not found' } };
  });
  const bucket = {
    download,
    upload: jest.fn(async (_path: string, image: Buffer) => { uploads.push(image); return { error: null }; }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://images.invalid/${path}` } }),
  };
  const storageFrom = jest.fn(() => bucket);
  const supabase = { from(table: string) {
    const query: any = {
      select: () => query, eq: () => query, in: () => query, limit: () => query,
      then: (resolve: any, reject: any) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject),
    };
    return query;
  }, storage: { from: storageFrom } };
  return { supabase, uploads, download, storageFrom };
}

async function render(cardImageBuffers?: ReadonlyMap<string, Buffer>, sourceImageCache?: ReadonlyMap<string, Buffer>) {
  const { supabase, uploads, download, storageFrom } = boundary(sourceImageCache);
  const publishTogether = jest.fn(async () => {});
  const count = await renderTokyoPelekaPostalPages({
    supabase: supabase as any, runId, snapshot, preparedCards: cards, cardImageBuffers,
    datePath: '2026/10/06', generationVersion: 1, publishTogether,
  });
  return { count, uploads, publishTogether, download, storageFrom };
}

beforeAll(async () => {
  template = await sharp({ create: { width: 900, height: 600, channels: 4, background: 'white' } }).png().toBuffer();
  cardBack = await sharp({ create: { width: 70, height: 90, channels: 4, background: 'black' } }).png().toBuffer();
});

beforeEach(() => jest.clearAllMocks());

test('full cache renders a valid postal PNG with postal prices and no product download', async () => {
  const first = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'red' } }).png().toBuffer();
  const second = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'blue' } }).png().toBuffer();

  const result = await render(new Map([['card-1', first], ['card-2', second]]));

  expect(result.count).toBe(1);
  expect(downloadImagesWithConcurrency).not.toHaveBeenCalled();
  expect(result.download).not.toHaveBeenCalled();
  expect(jest.mocked(composePage).mock.calls[0][0].cards.map(card => [card.id, card.price_high, card.price_low]))
    .toEqual([['card-2', 12400, 9900], ['card-1', 12300, 9800]]);
  expect((await sharp(result.uploads[0]).metadata()).format).toBe('png');
  expect(result.publishTogether).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'postal', status: 'generated', card_ids: ['card-2', 'card-1'] }),
  ]);
});

test('mixed cache downloads only the missing product and no cache keeps the existing URL path', async () => {
  const first = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'red' } }).png().toBuffer();
  const second = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'blue' } }).png().toBuffer();
  jest.mocked(downloadImagesWithConcurrency).mockResolvedValueOnce([second]);

  const mixed = await render(new Map([['card-1', first]]));

  expect(downloadImagesWithConcurrency).toHaveBeenCalledWith('', ['https://postal.invalid/2.png'], 8);
  expect(mixed.download).not.toHaveBeenCalled();
  jest.clearAllMocks();
  jest.mocked(downloadImagesWithConcurrency).mockResolvedValueOnce([first, second]);

  const uncached = await render();

  expect(downloadImagesWithConcurrency).toHaveBeenCalledWith('', [
    'https://postal.invalid/2.png', 'https://postal.invalid/1.png',
  ], 8);
  expect(uncached.download).not.toHaveBeenCalled();
});

test('invalid cached bytes fail closed without publication or redownload', async () => {
  const second = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'blue' } }).png().toBuffer();
  const publishTogether = jest.fn(async () => {});
  const { supabase } = boundary();

  await expect(renderTokyoPelekaPostalPages({
    supabase: supabase as any, runId, snapshot, preparedCards: cards,
    cardImageBuffers: new Map([['card-1', Buffer.from('invalid')], ['card-2', second]]),
    datePath: '2026/10/06', generationVersion: 1, publishTogether,
  })).rejects.toThrow('Peleka郵送商品の画像が不正です: sourceId=source-1');
  expect(downloadImagesWithConcurrency).not.toHaveBeenCalled();
  expect(publishTogether).not.toHaveBeenCalled();
});

test('transient download failure retries only the same failed URL at lower concurrency', async () => {
  jest.mocked(downloadImagesWithConcurrency)
    .mockResolvedValueOnce([cardBack, null])
    .mockResolvedValueOnce([null])
    .mockResolvedValueOnce([cardBack]);

  const result = await render();

  expect(jest.mocked(downloadImagesWithConcurrency).mock.calls).toEqual([
    ['', ['https://postal.invalid/2.png', 'https://postal.invalid/1.png'], 8],
    ['', ['https://postal.invalid/1.png'], 2],
    ['', ['https://postal.invalid/1.png'], 2],
  ]);
  expect(result.count).toBe(1);
  expect(result.publishTogether).toHaveBeenCalledTimes(1);
  expect(result.download).not.toHaveBeenCalled();
  expect((await sharp(result.uploads[0]).metadata()).format).toBe('png');
});

test('persistent same-URL failure uses only the exact hashed source-image cache and keeps postal prices', async () => {
  const cached = await sharp({ create: { width: 70, height: 90, channels: 3, background: 'blue' } }).png().toBuffer();
  jest.mocked(downloadImagesWithConcurrency)
    .mockResolvedValueOnce([cardBack, null])
    .mockResolvedValueOnce([null])
    .mockResolvedValueOnce([null]);
  const imageUrl = 'https://postal.invalid/1.png';
  const expectedKey = sourceImageCacheKey(imageUrl);

  const result = await render(undefined, new Map([[expectedKey, cached]]));

  expect(result.download).toHaveBeenCalledTimes(1);
  expect(result.download).toHaveBeenCalledWith(expectedKey);
  expect(result.storageFrom).toHaveBeenCalledWith('haraka-images');
  expect(jest.mocked(downloadImagesWithConcurrency).mock.invocationCallOrder[2])
    .toBeLessThan(result.download.mock.invocationCallOrder[0]);
  expect(jest.mocked(composePage).mock.calls[0][0].cards.map(card => [card.id, card.price_high, card.price_low]))
    .toEqual([['card-2', 12400, 9900], ['card-1', 12300, 9800]]);
  expect((await sharp(result.uploads[0]).metadata()).format).toBe('png');
  expect(result.publishTogether).toHaveBeenCalledTimes(1);
});

test('persistent download failure stops after three attempts without publishing partial pages', async () => {
  jest.mocked(downloadImagesWithConcurrency)
    .mockResolvedValueOnce([cardBack, null])
    .mockResolvedValueOnce([null])
    .mockResolvedValueOnce([null]);
  const { supabase, uploads, download } = boundary();
  const publishTogether = jest.fn(async () => {});

  await expect(renderTokyoPelekaPostalPages({
    supabase: supabase as any, runId, snapshot, preparedCards: cards,
    datePath: '2026/10/06', generationVersion: 1, publishTogether,
  })).rejects.toThrow('Peleka郵送商品の画像取得失敗: sourceId=source-1');
  expect(downloadImagesWithConcurrency).toHaveBeenCalledTimes(3);
  expect(download).toHaveBeenCalledWith(sourceImageCacheKey('https://postal.invalid/1.png'));
  expect(publishTogether).not.toHaveBeenCalled();
  expect(uploads).toHaveLength(0);
});
