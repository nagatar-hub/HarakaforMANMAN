import { createHash } from 'node:crypto';
import { captureTokyoRepairFixture, sanitizeTokyoRepairInput, safeTokyoRepairSite } from '../lib/tokyo-repair-fixture';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import { planTokyoGalleryPages } from '../jobs/generate';
import { normalizeStorePricingSettings } from '@haraka/shared';
import { completeOriparkCoverage } from '../lib/oripark-coverage';
import { compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync';

const runId = '11111111-1111-4111-8111-111111111111';
const importId = '22222222-2222-4222-8222-222222222222';
const input = () => ({ snapshot: { id: 'candidate', store: 'manman-akihabara', order_list_import_id: importId,
  business_date: '2026-11-19', report: { pricing_version: 1, price_sources: {}, raw_response: { token: 'DO_NOT_COPY' } },
  settings: { secret: 'DO_NOT_COPY' } },
  products: [{ id: 'box-1', franchise: 'ONE PIECE', product_type: 'box', name: '謀略の王国', model_number: null,
    source_price: 20000, price_high: 18000, price_low: 17000, image_url: 'https://example.com/card.png', origins: [],
    raw_row: { uploaded_by: 'private@example.com' } }], imageMappings: [], dbCards: [] });
const env = { STORE_NAME: 'manman-akihabara', TOKYO_REPAIR_FIXTURE_BUCKET: 'haraka-private-fixtures' };
const capture = () => ({ runId, importId, snapshotId: null, stage: 'prepare' as const,
  error: new Error('Original private product error'), input: input() });

test('failure site includes only fixed production modules, line numbers and allowlisted functions', () => {
  const error = new Error('private message');
  error.stack = 'Error: private message\n    at buildTokyoPreparedCards (/app/packages/job/dist/lib/tokyo-normal-cards.js:168:10)';
  expect(safeTokyoRepairSite(error)).toEqual({ module: 'lib/tokyo-normal-cards', line: 168, function: 'buildTokyoPreparedCards' });
  error.stack = 'Error: private\n    at stealSecrets (/app/packages/job/dist/lib/tokyo-normal-cards.js:168:10)';
  expect(safeTokyoRepairSite(error)).toEqual({ module: 'lib/tokyo-normal-cards', line: 168 });
  error.stack = 'Error: private\n    at buildTokyoPreparedCards (https://private.test/app/packages/job/dist/lib/tokyo-normal-cards.js:168:10)\n at leak (/app/packages/job/dist/lib/secret.js:1:1)';
  expect(safeTokyoRepairSite(error)).toBeUndefined();
});

test('prepare fixture keeps reconstruction identical while dropping unused private fields', () => {
  const original = input();
  const safe = sanitizeTokyoRepairInput('prepare', original);
  expect(JSON.stringify(safe)).not.toMatch(/DO_NOT_COPY|uploaded_by|private@example/);
  expect(buildTokyoPreparedCards(runId, { snapshot: safe.snapshot, products: safe.products } as any))
    .toEqual(buildTokyoPreparedCards(runId, original as any));
});

test('fixture URL queries and free-form evidence prose are not copied', () => {
  const value = input() as any;
  value.products[0].image_url = 'https://example.com/card.png?signature=PRIVATE_TOKEN#private';
  value.imageMappings = [{ source_shinsoku_id: 'box-1', evidence: { note: 'private operator identity',
    identity_note: 'private note', source_url: 'https://example.com/public.png?token=PRIVATE_TOKEN',
    no_sample: true, arbitrary_debug: { secret: 'PRIVATE_TOKEN' } } }];
  const serialized = JSON.stringify(sanitizeTokyoRepairInput('prepare', value));
  expect(serialized).toContain('https://example.com/card.png');
  expect(serialized).not.toMatch(/PRIVATE_TOKEN|private operator|private note|arbitrary_debug|signature|#private/);
});

test('capture uses private create-only upload with exact original-error hash', async () => {
  const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  expect(await captureTokyoRepairFixture(capture(), { env, fetchImpl, tokenFetcher: async () => 'PRIVATE_TOKEN', now: new Date('2026-11-19T04:00:00Z') })).toBe('created');
  const [url, options] = (fetchImpl as jest.Mock).mock.calls[0];
  expect(new URL(url).origin).toBe('https://storage.googleapis.com');
  expect(new URL(url).searchParams.get('ifGenerationMatch')).toBe('0');
  expect(new URL(url).searchParams.get('name')).toBe(`tokyo-repair-fixtures/${runId}/prepare.json`);
  expect(options.redirect).toBe('error');
  const body = JSON.parse(options.body);
  expect(body).toMatchObject({ schemaVersion: 1, store: env.STORE_NAME, runId, importId, snapshotId: null, stage: 'prepare',
    errorSha256: createHash('sha256').update(capture().error.message).digest('hex') });
  expect(options.body).not.toMatch(/PRIVATE_TOKEN|Original private product error/);
});

test('duplicate fixture is retained and disabled capture has no IO', async () => {
  const fetchImpl = jest.fn(async () => new Response('', { status: 412 })) as unknown as typeof fetch;
  const tokenFetcher = jest.fn(async () => 'token');
  expect(await captureTokyoRepairFixture(capture(), { env: {}, fetchImpl, tokenFetcher })).toBe('disabled');
  expect(tokenFetcher).not.toHaveBeenCalled();
  expect(await captureTokyoRepairFixture(capture(), { env, fetchImpl, tokenFetcher })).toBe('exists');
});

test('capture failures are swallowed without replacing original error or leaking details', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const original = capture();
    const status = await captureTokyoRepairFixture(original, { env, tokenFetcher: async () => { throw new Error('PRIVATE_CREDENTIAL'); } });
    expect(status).toBe('failed');
    expect(original.error.message).toBe('Original private product error');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_CREDENTIAL');
    const sensitive = capture(); sensitive.input.products[0].name = 'operator@example.com';
    const tokenFetcher = jest.fn(async () => 'token');
    expect(await captureTokyoRepairFixture(sensitive, { env, tokenFetcher })).toBe('failed');
    expect(tokenFetcher).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test('generate planning fixture reproduces a pure layout failure and drops source/raw metadata', () => {
  const original = { cards: [{ id: 'card-1', franchise: 'Pokemon', card_name: 'カイ', grade: 'PSA10', tag: 'SAR',
    price_high: 9000, price_low: 9000, raw_import_id: 'private-import', raw_row: { customer: 'private' } }], layouts: [], rules: [] };
  const safe = sanitizeTokyoRepairInput('generate_plan', original);
  expect(JSON.stringify(safe)).not.toMatch(/private|raw_row|raw_import_id/);
  expect(() => planTokyoGalleryPages(original.cards as any, [], [])).toThrow('東京 PSA10 レイアウトがありません');
  expect(() => planTokyoGalleryPages(safe.cards as any, safe.layouts as any, safe.rules as any)).toThrow('東京 PSA10 レイアウトがありません');
});

test('the production ambiguous-image failure reproduces from the sanitized prepare input', () => {
  const original = input() as any;
  original.snapshot.report.oripark_coverage = { version: 1, runId, businessDate: '2026-11-19', fingerprint: 'baseline',
    items: ['a', 'b'].map(id => ({ oriparkCardId: id, productId: 'box-1', imageUrl: `https://example.com/${id}.png`, altImageUrl: null, tag: 'BOX', rarity: null })) };
  const safe = sanitizeTokyoRepairInput('prepare', original);
  for (const value of [original, safe]) {
    expect(() => buildTokyoPreparedCards(runId, value as any, value.imageMappings as any, value.dbCards as any))
      .toThrow('Oripark補完画像が曖昧です: box-1');
  }
});

test('planning capture preserves a successful plan including grouping and layout preference', () => {
  const original = { cards: [{ id: 'card-1', franchise: 'Pokemon', card_name: 'カイ', grade: 'PSA10', tag: 'SAR', price_high: 9000, price_low: 9000 }],
    layouts: [{ id: 'layout-1', store: env.STORE_NAME, franchise: 'Pokemon', kind: 'store', slug: 'psa_4x4', is_active: true, total_slots: 16, priority: 1,
      template_storage_path: 'private/internal/path' }], rules: [] };
  const safe = sanitizeTokyoRepairInput('generate_plan', original);
  expect(planTokyoGalleryPages(safe.cards as any, safe.layouts as any, safe.rules as any))
    .toEqual(planTokyoGalleryPages(original.cards as any, original.layouts as any, []));
});

test('coverage replay retains edition identity, original prices and discount settings without raw private columns', async () => {
  const settings = normalizeStorePricingSettings({ tokyo_source_discount_rates: { kecak: { high: 0.1, low: 0.2 } } });
  const value = {
    snapshot: { ...input().snapshot, settings, fetched_at: '2026-11-19T03:00:00Z' },
    preCoverage: { products: [], unmatched: [{ private_notes: 'DO_NOT_COPY' }], priceSources: {} },
    baseline: { runId, businessDate: '2026-11-19', fingerprint: 'baseline', cards: ['a', 'b'].map((id, index) => ({
      id: `prepared-${id}`, franchise: 'ONE PIECE', card_name: 'サボ', list_no: 'OP07-118', grade: 'PSA10',
      tag: 'パラレル', rarity: null, image_url: `https://example.com/${id}.png`, alt_image_url: 'https://example.com/a.png',
      excel_product_id: id, source: 'order_list', db_card: { card_name: 'サボ' },
      raw_import: { source_price: index ? 18054 : 8262, price_source: 'order_list', raw_row: {
        商品ID: id, 画像: `https://example.com/${id}.png`, エキスパンション: index ? 'OP13' : '3rd ANNIVERSARY SET',
        uploaded_by: 'private@example.com', secret: 'DO_NOT_COPY',
      } },
    })) }, imageMappings: [], dbCards: [],
  };
  const safe = sanitizeTokyoRepairInput('coverage_prepare', value) as any;
  expect(JSON.stringify(safe)).not.toMatch(/private|DO_NOT_COPY|uploaded_by|secret/);
  expect(safe.snapshot.settings).toEqual({ tokyo_source_discount_rates: settings.tokyo_source_discount_rates,
    tokyo_outlier_guard: settings.tokyo_outlier_guard, tokyo_price_max_age_days: settings.tokyo_price_max_age_days });
  const replay = (data: any) => {
    const result = structuredClone(data.preCoverage); result.unmatched = [];
    const rates = normalizeStorePricingSettings(data.snapshot.settings);
    const coverage = completeOriparkCoverage(result, data.baseline, data.snapshot.business_date, rates.tokyo_price_max_age_days,
      row => compareTokyoSourceProducts([row], [], rates, data.snapshot.fetched_at));
    return { products: result.products, coverage };
  };
  expect(replay(safe)).toEqual(replay(value));
  expect(replay(safe).products).toHaveLength(2);
  const fetchImpl = jest.fn(async () => new Response('{}')) as unknown as typeof fetch;
  expect(await captureTokyoRepairFixture({ ...capture(), stage: 'coverage_prepare', failurePoint: 'prepare', input: value },
    { env, fetchImpl, tokenFetcher: async () => 'token' })).toBe('created');
  const [url, options] = (fetchImpl as jest.Mock).mock.calls[0];
  expect(new URL(url).searchParams.get('name')).toBe(`tokyo-repair-fixtures/${runId}/coverage-prepare.json`);
  expect(JSON.parse(options.body)).toMatchObject({ stage: 'coverage_prepare', failurePoint: 'prepare' });
});
