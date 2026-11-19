import { createHash } from 'node:crypto';

const STORE = 'manman-akihabara';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type Capture = { runId: string; importId: string; snapshotId: string | null;
  stage: 'prepare' | 'coverage_prepare' | 'generate_plan'; failurePoint?: 'coverage' | 'prepare'; error: unknown; input: Row };
const siteFunctions: Record<string, string[]> = {
  'lib/tokyo-normal-cards': ['buildTokyoPreparedCards', 'loadTokyoCardImageMappings'],
  'lib/oripark-coverage': ['loadOriparkCoverage', 'coverageMatches', 'completeOriparkCoverage', 'readCoverageReport', 'assertOriparkCoverage'],
  'lib/haraka-card-images': ['harakaImageUrl', 'findHarakaImage', 'loadTokyoHarakaCards'],
  'lib/page-planner': ['planPages'],
  'jobs/generate': ['planTokyoGalleryPages'],
};
export function safeTokyoRepairSite(error: Error): { module: string; line: number; function?: string } | undefined {
  // Cloud Run's production image has this fixed application root. Never forward raw paths or stack lines.
  for (const frame of (error.stack ?? '').split('\n').slice(1, 30)) {
    const match = /^\s*at\s+(?:(?:Object\.)?([A-Za-z_$][\w$]*)\s+\()?\/?app\/packages\/job\/(?:dist|src)\/((?:lib|jobs)\/[a-z-]+)\.(?:js|ts):([1-9]\d{0,5}):[1-9]\d*\)?$/.exec(frame);
    if (!match || !Object.hasOwn(siteFunctions, match[2])) continue;
    return { module: match[2], line: Number(match[3]),
      ...(siteFunctions[match[2]].includes(match[1]) ? { function: match[1] } : {}) };
  }
  return undefined;
}
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
async function metadataToken(): Promise<string> {
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Fixture upload authentication unavailable');
  const value = await response.json() as { access_token?: unknown };
  if (typeof value.access_token !== 'string' || !value.access_token) throw new Error('Fixture upload authentication unavailable');
  return value.access_token;
}

function scalar(value: unknown): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length > 4096
    || /(?:Bearer\s+[A-Za-z0-9_.-]+|sb_(?:secret|publishable)_|\beyJ[A-Za-z0-9_-]{20,}\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(value)) {
    throw new Error('Unsafe fixture value');
  }
  return value;
}
function publicUrl(value: unknown): unknown {
  if (value == null || value === '') return value;
  if (typeof value !== 'string') return scalar(value);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = ''; url.hash = '';
    return scalar(url.href);
  } catch { return null; }
}
function pick(value: unknown, fields: string[]): Row {
  const input = object(value);
  return Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key,
    /(?:_url|Url)$/.test(key) ? publicUrl(input[key]) : scalar(input[key])]));
}
const rows = (value: unknown, mapper: (row: unknown) => Row): Row[] => {
  if (!Array.isArray(value) || value.length > 20000) throw new Error('Invalid fixture rows');
  return value.map(mapper);
};
const productFields = ['id', 'franchise', 'product_type', 'name', 'model_number', 'image_url', 'source_price',
  'price_high', 'price_low', 'selected_high_source', 'selected_low_source'];
const originFields = ['source', 'id', 'franchise', 'name', 'modelNumber', 'productType', 'sourcePrice', 'rawPrice',
  'observedAt', 'highRate', 'highPrice', 'lowRate', 'lowPrice', 'excluded', 'imageUrl', 'rarity', 'dbCardId', 'shopId', 'shopName'];
const mappingFields = ['source_shinsoku_id', 'franchise', 'product_type', 'name', 'model_number', 'provider',
  'provider_product_id', 'tcgmp_product_id', 'tcgmp_sku', 'image_url', 'sha256', 'verified_at'];
const dbFields = ['id', 'store', 'franchise', 'card_name', 'grade', 'list_no', 'tag', 'image_url', 'alt_image_url', 'image_status'];
const evidenceFields = ['pixel_exact', 'source_image_sha256', 'source_sha256_equal', 'no_sample', 'no_slab', 'variant_confirmed',
  'tag', 'tag_plan_sha256', 'verified_by', 'user_approved', 'visual_identity_verified', 'verification_method',
  'reviewed_asset_sha256', 'review_manifest_sha256', 'source_url'];

function coverage(value: unknown): Row | undefined {
  if (value == null) return undefined;
  const result = pick(value, ['version', 'runId', 'businessDate', 'fingerprint']);
  result.items = rows(object(value).items, item => {
    const row = pick(item, ['oriparkCardId', 'productId', 'imageUrl', 'altImageUrl', 'tag', 'rarity']);
    if (object(item).edition != null) row.edition = pick(object(item).edition, ['sourceProductId', 'name', 'expansion']);
    return row;
  });
  return result;
}

const priceSources = (value: unknown): Row => Object.fromEntries(Object.entries(object(value)).map(([id, source]) =>
  [String(scalar(id)), pick(source, ['source', 'source_id', 'price'])]));
const products = (value: unknown): Row[] => rows(value, row => ({ ...pick(row, productFields),
  origins: rows(object(row).origins, origin => pick(origin, originFields)) }));

function replayBaseline(value: unknown): Row {
  const baseline = object(value);
  return { ...pick(baseline, ['runId', 'businessDate', 'fingerprint']), cards: rows(baseline.cards, value => {
    const card = object(value);
    const raw = object(card.raw_import);
    const rawRow = object(raw.raw_row);
    return { ...pick(card, ['id', 'franchise', 'card_name', 'list_no', 'grade', 'tag', 'rarity', 'image_url',
      'alt_image_url', 'excel_product_id', 'source']),
      db_card: card.db_card == null ? null : pick(card.db_card, ['card_name']),
      raw_import: card.raw_import == null ? null : { ...pick(raw, ['source_price', 'price_source']),
        raw_row: { ...pick(rawRow, ['エキスパンション', '商品ID', 'pokemon_box_price_source']),
          ...(Object.hasOwn(rawRow, '画像') ? { '画像': publicUrl(rawRow['画像']) } : {}) } },
    };
  }) };
}

/** Keep only pure-function inputs; no import rows, arbitrary report/debug data, signed query strings or identities. */
export function sanitizeTokyoRepairInput(stage: Capture['stage'], input: Row): Row {
  if (stage === 'generate_plan') return {
    cards: rows(input.cards, row => pick(row, ['id', 'source_shinsoku_id', 'franchise', 'card_name', 'grade', 'list_no',
      'tag', 'price_high', 'price_low', 'image_url', 'alt_image_url'])),
    layouts: rows(input.layouts, row => pick(row, ['id', 'store', 'kind', 'franchise', 'slug', 'is_active', 'is_default', 'total_slots', 'priority'])),
    rules: rows(input.rules, row => pick(row, ['id', 'store', 'franchise', 'tag_pattern', 'match_type', 'behavior', 'priority', 'group_key'])),
  };
  const snapshot = object(input.snapshot);
  if (snapshot.store !== STORE) throw new Error('Unexpected fixture store');
  const safeSnapshot = pick(snapshot, ['id', 'store', 'order_list_import_id', 'fetched_at', 'business_date']);
  const report = object(snapshot.report);
  safeSnapshot.report = { ...pick(report, ['pricing_version']),
    ...(report.oripark_coverage ? { oripark_coverage: coverage(report.oripark_coverage) } : {}),
    price_sources: priceSources(report.price_sources),
  };
  // Prepared-card reconstruction consumes immutable product prices, not settings or API responses.
  safeSnapshot.settings = {};
  const extra: Row = {};
  if (stage === 'coverage_prepare') {
    const settings = object(snapshot.settings);
    safeSnapshot.settings = { ...pick(settings, ['tokyo_price_max_age_days']),
      tokyo_outlier_guard: pick(settings.tokyo_outlier_guard, ['max_median_ratio', 'max_source_price']),
      tokyo_source_discount_rates: Object.fromEntries(['kecak', 'blue_rocket', 'extoreca', 'toreca_bank', 'avirile', 'shinsoku']
        .map(source => [source, pick(object(settings.tokyo_source_discount_rates)[source], ['high', 'low'])])),
    };
    const preCoverage = object(input.preCoverage);
    extra.preCoverage = { products: products(preCoverage.products), unmatched: [], priceSources: priceSources(preCoverage.priceSources) };
    extra.baseline = replayBaseline(input.baseline);
  }
  return { snapshot: safeSnapshot,
    ...extra,
    ...(input.products ? { products: products(input.products) } : stage === 'prepare' ? { products: products(input.products) } : {}),
    imageMappings: rows(input.imageMappings, row => {
      const evidence = object(object(row).evidence);
      return { ...pick(row, mappingFields), evidence: { ...pick(evidence, evidenceFields),
        ...Object.fromEntries(['note', 'identity_note', 'source_title', 'tag_basis'].filter(key => Object.hasOwn(evidence, key))
          .map(key => [key, typeof evidence[key] === 'string' && (evidence[key] as string).trim()
            ? 'verified evidence' : scalar(evidence[key])])) } };
    }),
    dbCards: rows(input.dbCards, row => pick(row, dbFields)),
  };
}

/** Best effort capture, create-only. Capture failures must never replace the original production exception. */
export async function captureTokyoRepairFixture(capture: Capture, options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; tokenFetcher?: () => Promise<string>; now?: Date;
} = {}): Promise<'disabled' | 'created' | 'exists' | 'failed'> {
  const env = options.env ?? process.env;
  const bucket = env.TOKYO_REPAIR_FIXTURE_BUCKET;
  if (!bucket || env.STORE_NAME !== STORE) return 'disabled';
  try {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket) || !UUID.test(capture.runId)
      || !UUID.test(capture.importId) || capture.snapshotId !== null && !UUID.test(capture.snapshotId)
      || !(capture.error instanceof Error)
      || capture.stage === 'coverage_prepare' && !['coverage', 'prepare'].includes(capture.failurePoint ?? '')) throw new Error('Invalid fixture identity');
    const input = sanitizeTokyoRepairInput(capture.stage, capture.input);
    const site = safeTokyoRepairSite(capture.error);
    const body = JSON.stringify({ schemaVersion: 1, store: STORE, runId: capture.runId, importId: capture.importId,
      snapshotId: capture.snapshotId, stage: capture.stage, capturedAt: (options.now ?? new Date()).toISOString(),
      ...(capture.stage === 'coverage_prepare' ? { failurePoint: capture.failurePoint } : {}),
      errorSha256: createHash('sha256').update(capture.error.message).digest('hex'), ...(site ? { site } : {}), input });
    if (Buffer.byteLength(body) > 10 * 1024 * 1024) throw new Error('Fixture size limit exceeded');
    const filename = { prepare: 'prepare', coverage_prepare: 'coverage-prepare', generate_plan: 'generate-plan' }[capture.stage];
    const name = `tokyo-repair-fixtures/${capture.runId}/${filename}.json`;
    const query = new URLSearchParams({ uploadType: 'media', name, ifGenerationMatch: '0' });
    const token = await (options.tokenFetcher ?? metadataToken)();
    const response = await (options.fetchImpl ?? fetch)(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
    });
    if (response.status === 412) return 'exists';
    if (!response.ok) throw new Error('Fixture upload failed');
    return 'created';
  } catch {
    console.warn('[tokyo-repair] Private replay fixture could not be captured');
    return 'failed';
  }
}
