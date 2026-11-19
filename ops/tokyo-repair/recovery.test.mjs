import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKYO_STORE, RecoveryError, sha256, recoveryRequestId, captureReplayFixture, recover, verifyReadback, validatePrepareFixture } from './recovery.mjs';
import { evaluateReplay, assertPlanOutput, assertPrepareOutput, assertCoverageOutput, runReplay } from './replay.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ID = '5de7b90b-0210-42b0-a0a8-332efb075e7a';
const NEXT = '6de7b90b-0210-42b0-a0a8-332efb075e7a';
const IMPORT = '6ee4256e-32da-4335-8bae-e0b00ac7ff05';
const SNAPSHOT = 'f349334f-cc3f-4d73-a321-da66004b3e5e';
const NOW = '2026-11-19T03:00:00.000Z';
const incident = () => ({ fingerprint: 'a'.repeat(64), store: TOKYO_STORE, runId: ID, importId: IMPORT, snapshotId: SNAPSHOT, stage: 'generate' });
function readback(runId = ID) {
  const product = { id: 'product-1', name: 'カード', franchise: 'Pokemon', model_number: '001/001', product_type: 'psa', price_high: 1000, price_low: 900, origins: [] };
  const prepared = { id: 'card-1', source_shinsoku_id: product.id, franchise: product.franchise, card_name: product.name, list_no: product.model_number, price_high: 1000, price_low: 900, image_url: 'https://example.com/card.png', alt_image_url: null, grade: 'PSA10' };
  const version = { runId, snapshotId: SNAPSHOT, revision: 1, fingerprint: 'a'.repeat(32) };
  return {
    run: { id: runId, store: TOKYO_STORE, status: 'completed', order_list_import_id: IMPORT, tokyo_snapshot_id: SNAPSHOT, prepare_done_at: NOW, plan_done_at: NOW,
      generate_done_at: NOW, completed_at: NOW, generate_claimed_at: null, total_prepared: 1, total_pages: 2, total_image_ng: 0, error_message: null },
    order: { id: IMPORT, store: TOKYO_STORE, business_date: '2026-11-19', status: 'applied', structural_valid: true, persistence_complete: true, confirmation_allow_unresolved: true },
    snapshot: { id: SNAPSHOT, store: TOKYO_STORE, order_list_import_id: IMPORT, business_date: '2026-11-19', report: { oripark_coverage: { items: [{ productId: product.id, imageUrl: prepared.image_url }] } } },
    products: [product], prepared: [prepared], revision: 1,
    pages: ['store', 'postal'].map(kind => ({ id: kind, kind, status: 'generated', card_ids: [prepared.id], image_url: 'https://example.com/page.png', image_key: `${kind}.png`, error_message: null, peleka_snapshot: kind === 'postal' ? version : null })),
    consumer: { schemaVersion: 1, store: TOKYO_STORE, ...version, businessDate: '2026-11-19', boxBuybackEnabled: true,
      products: [{ sourceId: product.id, name: product.name, franchise: product.franchise, modelNumber: product.model_number, imageUrl: prepared.image_url, productType: 'PSA10', priceHigh: 1000, priceLow: 900 }] },
  };
}
function fixture() {
  const data = readback();
  return { schemaVersion: 1, store: TOKYO_STORE, runId: ID, importId: IMPORT, snapshotId: SNAPSHOT, stage: 'prepare',
    capturedAt: NOW, errorSha256: sha256('the original failure'), input: { snapshot: data.snapshot, products: data.products, imageMappings: [], dbCards: [] } };
}
function fakeEnvironment(stage = 'generate') {
  const data = readback();
  data.run.status = 'failed'; data.run.generate_done_at = null; data.run.error_message = 'the original failure';
  if (stage === 'sync') { data.run.prepare_done_at = null; data.run.plan_done_at = null; }
  const original = structuredClone(data.run);
  let latest = data.run;
  let now = Date.parse(NOW);
  const launches = [];
  let queued = 0;
  const d = {
    now: () => new Date(now), sleep: async ms => { now += ms; }, pollMs: 1000, timeoutMs: 5000,
    db: {
      async rows(table, filters) {
        if (table === 'order_list_import') return [data.order];
        if (table === 'run') return filters.id ? [filters.id === `eq.${latest.id}` ? latest : original] : [latest];
        if (table === 'tokyo_buyback_snapshot') return [data.snapshot];
        if (table === 'tokyo_buyback_product') return data.products;
        if (table === 'prepared_card') return data.prepared;
        if (table === 'generated_page') return data.pages;
        if (table === 'tokyo_peleka_catalog_revisions') return [{ last_revision: 1 }];
        throw new Error(`Unexpected table ${table}`);
      },
      async rpc(name, args) {
        assert.equal(name, 'queue_order_list_import_resync'); queued++;
        assert.deepEqual(args.p_mappings, []); assert.deepEqual(args.p_new_cards, []); assert.deepEqual(args.p_exclusions, []);
        return { action: 'start_job', launch_claimed_at: NOW, request_id: args.p_request_id, import_id: IMPORT, request_fingerprint: args.p_request_fingerprint };
      },
      async claimGenerate(run) {
        assert.equal(run.id, latest.id); latest = { ...latest, status: 'running', error_message: null, generate_claimed_at: NOW };
        return 'secret-claim-token';
      },
    },
    async consumer() { return data.consumer; },
    async readFixture() { return fixture(); },
    async launch(kind, env) {
      launches.push({ kind, env });
      if (kind === 'sync') {
        latest = { ...readback(NEXT).run, generate_done_at: null, tokyo_snapshot_id: NEXT,
          order_list_sync_request_id: env.ORDER_LIST_SYNC_REQUEST_ID, order_list_sync_request_fingerprint: env.ORDER_LIST_SYNC_REQUEST_FINGERPRINT };
        data.snapshot.id = NEXT;
      } else {
        latest = { ...latest, status: 'completed', generate_done_at: NOW, generate_claimed_at: null, error_message: null };
        const completed = readback(latest.id); data.pages = completed.pages; data.consumer = completed.consumer;
        data.pages[1].peleka_snapshot.snapshotId = latest.tokyo_snapshot_id;
        data.consumer.snapshotId = latest.tokyo_snapshot_id;
      }
    },
  };
  return { d, data, launches, original, queued: () => queued, latest: () => latest, setLatest: value => { latest = value; } };
}

test('request UUID is deterministic and scoped to the incident fingerprint', () => {
  assert.equal(recoveryRequestId('a'.repeat(64)), recoveryRequestId('a'.repeat(64)));
  assert.notEqual(recoveryRequestId('a'.repeat(64)), recoveryRequestId('b'.repeat(64)));
  assert.match(recoveryRequestId('a'.repeat(64)), /^[0-9a-f-]{36}$/);
});
test('full publication readback accepts matching products, two page kinds and consumer', () => {
  assert.equal(verifyReadback(readback(), { runId: ID }).ok, true);
});
for (const [name, mutate, expected] of [
  ['wrong price', x => { x.prepared[0].price_high++; }, 'immutable_prices'],
  ['missing page image', x => { x.pages[0].image_key = null; }, 'pages_complete'],
  ['duplicate store card', x => { x.pages[0].card_ids.push('card-1'); }, 'store_card_identity'],
  ['consumer stale run', x => { x.consumer.runId = NEXT; }, 'consumer_identity'],
  ['consumer wrong price', x => { x.consumer.products[0].priceHigh++; }, 'consumer_products'],
  ['postal stale fingerprint', x => { x.pages[1].peleka_snapshot.fingerprint = 'b'.repeat(32); }, 'postal_consumer_version'],
  ['missing coverage', x => { x.snapshot.report.oripark_coverage.items[0].productId = 'missing'; }, 'oripark_coverage'],
  ['completion timestamp alone', x => { x.run.generate_done_at = null; }, 'run_completed'],
  ['unaccounted image exclusion', x => { x.run.total_image_ng = 1; }, 'image_exclusions_reconcile'],
]) test(`publication rejects ${name}`, () => {
  const data = readback(); mutate(data);
  const result = verifyReadback(data, { runId: ID });
  assert.equal(result.ok, false); assert.equal(result.checks.find(c => c.name === expected).ok, false);
});
test('sync repair queues no review changes, launches once and verifies new generation', async () => {
  const env = fakeEnvironment('sync');
  const result = await recover({ ...incident(), stage: 'sync' }, env.d);
  assert.equal(result.ok, true); assert.equal(result.runId, NEXT); assert.equal(result.originalRunId, ID);
  assert.deepEqual(env.launches.map(l => l.kind), ['sync', 'generate']); assert.equal(env.queued(), 1);
  assert.equal(env.launches[0].env.STORE_NAME, TOKYO_STORE);
  assert.equal(JSON.stringify(result).includes('secret-claim-token'), false);
  const again = await recover({ ...incident(), stage: 'sync' }, env.d);
  assert.equal(again.runId, NEXT); assert.equal(env.queued(), 1); assert.equal(env.launches.length, 2);
});
test('generation repair uses exact failed run and is idempotent after completion', async () => {
  const env = fakeEnvironment();
  assert.equal((await recover(incident(), env.d)).ok, true);
  assert.equal((await recover(incident(), env.d)).ok, true);
  assert.equal(env.queued(), 0); assert.equal(env.launches.length, 1);
  assert.equal(env.launches[0].env.RUN_ID, ID);
});
test('newer unrelated run aborts without mutation', async () => {
  const env = fakeEnvironment(); env.setLatest({ ...env.latest(), id: NEXT });
  await assert.rejects(recover(incident(), env.d), { code: 'RUN_SUPERSEDED' });
  assert.equal(env.launches.length, 0); assert.equal(env.queued(), 0);
});
test('prior business day and other tenant are rejected', async () => {
  const env = fakeEnvironment(); env.data.order.business_date = '2026-11-18';
  await assert.rejects(recover(incident(), env.d), { code: 'IMPORT_SUPERSEDED_OR_NOT_TODAY' });
  await assert.rejects(recover({ ...incident(), store: 'oripark' }, env.d), { code: 'INVALID_INCIDENT' });
});
test('unknown stage never queues a job', async () => {
  const env = fakeEnvironment();
  await assert.rejects(recover({ ...incident(), stage: 'unknown' }, env.d), { code: 'UNKNOWN_FAILURE_STAGE' });
  assert.equal(env.queued(), 0);
});
test('fresh generation claim is monitored without acquiring another claim', async () => {
  const env = fakeEnvironment(); env.setLatest({ ...env.latest(), status: 'running', generate_claimed_at: NOW });
  env.d.db.claimGenerate = () => { throw new Error('must not reclaim'); };
  await assert.rejects(recover(incident(), env.d), { code: 'RECOVERY_TIMEOUT' });
  assert.equal(env.launches.length, 0);
});
test('unknown launch result keeps the claim and does not launch twice', async () => {
  const env = fakeEnvironment();
  let launches = 0;
  env.d.launch = async () => { launches++; throw new RecoveryError('LAUNCH_RESULT_UNKNOWN'); };
  await assert.rejects(recover(incident(), env.d), { code: 'LAUNCH_PENDING_TIMEOUT' });
  assert.equal(launches, 1); assert.equal(env.latest().status, 'running');
});
test('a failed newly synchronized run is terminal, never silently requeued', async () => {
  const env = fakeEnvironment('sync');
  env.d.launch = async (kind, vars) => { env.setLatest({ ...env.latest(), id: NEXT, status: 'failed', order_list_sync_request_id: vars.ORDER_LIST_SYNC_REQUEST_ID, order_list_sync_request_fingerprint: vars.ORDER_LIST_SYNC_REQUEST_FINGERPRINT }); };
  await assert.rejects(recover({ ...incident(), stage: 'sync' }, env.d), { code: 'SYNC_FAILED' });
  assert.equal(env.queued(), 1);
});
test('capture validates exact persisted failure, immutable input hash and stage', async () => {
  const env = fakeEnvironment('sync');
  const captured = await captureReplayFixture({ ...incident(), stage: 'sync' }, env.d);
  assert.equal(captured.inputSha256, sha256(captured.input));
  assert.equal(captured.incidentFingerprint, incident().fingerprint);
  env.d.readFixture = async () => ({ ...fixture(), errorSha256: '0'.repeat(64) });
  await assert.rejects(captureReplayFixture({ ...incident(), stage: 'sync' }, env.d), { code: 'FIXTURE_INCIDENT_MISMATCH' });
});
test('missing fixture fails closed and does not manufacture snapshot evidence', async () => {
  const env = fakeEnvironment('sync'); env.d.readFixture = async () => { throw new RecoveryError('FIXTURE_UNAVAILABLE'); };
  await assert.rejects(captureReplayFixture({ ...incident(), stage: 'sync' }, env.d), { code: 'FIXTURE_UNAVAILABLE' });
});
test('baseline replay requires exact expected failure; success or another exception reject', () => {
  const f = fixture();
  assert.equal(evaluateReplay(f, { outcome: 'error', errorSha256: f.errorSha256 }, 'baseline').exitCode, 10);
  assert.throws(() => evaluateReplay(f, { outcome: 'success' }, 'baseline'), /BASELINE_DID_NOT_REPRODUCE/);
  assert.throws(() => evaluateReplay(f, { outcome: 'error', errorSha256: '0'.repeat(64) }, 'baseline'), /BASELINE_DID_NOT_REPRODUCE/);
});
test('candidate replay rejects price changes, dropped products and mutated inputs', () => {
  const f = fixture(); const cards = readback().prepared;
  assert.equal(evaluateReplay(f, { outcome: 'success', inputUnchanged: true, result: cards }, 'candidate').exitCode, 0);
  assert.throws(() => evaluateReplay(f, { outcome: 'success', inputUnchanged: false, result: cards }, 'candidate'), /MUTATED_INPUT/);
  assert.throws(() => assertPrepareOutput(f.input, [{ ...cards[0], price_high: 1 }]), /IMMUTABLE_PRICE_CHANGED/);
  assert.throws(() => assertPrepareOutput(f.input, []), /PREPARED_EMPTY/);
});
test('removing the ambiguity guard cannot make mismatching artwork pass replay', () => {
  const f = fixture();
  f.input.snapshot.report.oripark_coverage.items.push({ productId: 'product-1', imageUrl: 'https://example.com/another-edition.png' });
  assert.throws(() => assertPrepareOutput(f.input, readback().prepared), /AMBIGUOUS_COVERAGE_EVIDENCE/);
});
test('fixture body hash detects substitution', () => {
  const f = fixture(); f.inputSha256 = sha256(f.input); f.input.products[0].name = 'changed';
  assert.throws(() => validatePrepareFixture(f), { code: 'FIXTURE_HASH_MISMATCH' });
});
test('planning validates exact card coverage, capacity and PSA/BOX separation', () => {
  const input = { cards: readback().prepared, layouts: [{ id: 'layout', is_active: true, slug: 'psa10', total_slots: 12 }], rules: [] };
  const plans = [{ cardIds: ['card-1'], layoutTemplateId: 'layout' }];
  assert.deepEqual(assertPlanOutput(input, plans), { cards: 1, pages: 1 });
  assert.throws(() => assertPlanOutput(input, [...plans, ...plans]), /PLANNED_CARD_COVERAGE/);
  input.layouts[0].total_slots = 0;
  assert.throws(() => assertPlanOutput(input, plans), /LAYOUT_CAPACITY/);
});
test('candidate process exit zero without a result cannot bypass acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'haraka-replay-test-'));
  try {
    const dir = join(root, 'packages/job/dist/lib'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tokyo-normal-cards.js'), 'exports.buildTokyoPreparedCards = () => process.exit(0);');
    assert.throws(() => runReplay(fixture(), root), /CANDIDATE_RESULT_INVALID/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    rmSync(root, { recursive: true, force: true });
  }
});
test('generation fixture is tied to the failed generation stage and current error', async () => {
  const env = fakeEnvironment();
  env.d.readFixture = async (runId, stage) => {
    assert.equal(runId, ID); assert.equal(stage, 'generate_plan');
    return { ...fixture(), stage, input: { cards: readback().prepared, layouts: [], rules: [] } };
  };
  const result = await captureReplayFixture(incident(), env.d);
  assert.equal(result.stage, 'generate_plan');
});
test('recovery refuses a replacement snapshot that is still the pre-repair snapshot', async () => {
  const env = fakeEnvironment('sync');
  env.d.launch = async (kind, vars) => {
    env.setLatest({ ...readback(NEXT).run, generate_done_at: null, order_list_sync_request_id: vars.ORDER_LIST_SYNC_REQUEST_ID,
      order_list_sync_request_fingerprint: vars.ORDER_LIST_SYNC_REQUEST_FINGERPRINT });
  };
  await assert.rejects(recover({ ...incident(), stage: 'sync' }, env.d), { code: 'SNAPSHOT_NOT_REPLACED' });
});
test('supersession after acquiring a claim releases only that unstarted claim', async () => {
  const env = fakeEnvironment(); let released = false;
  env.d.db.claimGenerate = async () => { env.setLatest({ ...env.latest(), id: NEXT }); return 'private-token'; };
  env.d.db.releaseUnstartedGenerate = async (run, token) => { assert.equal(run.id, ID); assert.equal(token, 'private-token'); released = true; };
  await assert.rejects(recover(incident(), env.d), { code: 'RUN_SUPERSEDED' });
  assert.equal(released, true); assert.equal(env.launches.length, 0);
});
test('consumer changing during final readback is rejected', async () => {
  const env = fakeEnvironment(); let reads = 0;
  env.d.consumer = async () => ({ ...env.data.consumer, fingerprint: (++reads === 1 ? 'a' : 'b').repeat(32) });
  await assert.rejects(recover(incident(), env.d), { code: 'CONSUMER_CHANGED' });
});

function coverageCase() {
  const base = readback();
  base.products[0].origins = [{ source: 'shinsoku', id: 'product-1', franchise: 'Pokemon', name: 'カード', modelNumber: '001/001', productType: 'PSA10' }];
  Object.assign(base.products[0], { source_price: 1000, selected_high_source: 'shinsoku', selected_low_source: 'shinsoku' });
  const priceSources = { 'product-1': { source: 'shinsoku', source_id: 'product-1', price: 1000 } };
  const baseline = { runId: NEXT, businessDate: '2026-11-19', fingerprint: 'b'.repeat(64), cards: ['A', 'B'].map((edition, index) => ({
    id: `oripark-${index}`, franchise: 'ONE PIECE', card_name: 'ルフィ', list_no: 'OP01-001', grade: 'PSA10', tag: 'キャラ', rarity: null,
    image_url: `https://example.com/${edition}.png`, alt_image_url: null, excel_product_id: `source-${edition}`, source: 'order_list',
    raw_import: { source_price: 10000, price_source: 'order_list', raw_row: { エキスパンション: `記念版${edition}`, 商品ID: `source-${edition}`, 画像: `https://example.com/${edition}.png` } },
  })) };
  const input = { snapshot: { ...base.snapshot, settings: { tokyo_source_discount_rates: { kecak: { high: 0.1, low: 0.2 } },
    tokyo_outlier_guard: { max_source_price: 100000, max_median_ratio: 3 }, tokyo_price_max_age_days: 0 } },
    preCoverage: { products: structuredClone(base.products), priceSources: structuredClone(priceSources), unmatched: [] },
    baseline, imageMappings: [], dbCards: [] };
  const coverage = { version: 1, runId: baseline.runId, businessDate: baseline.businessDate, fingerprint: baseline.fingerprint, items: [] };
  const products = structuredClone(base.products), cards = structuredClone(base.prepared);
  for (const row of baseline.cards) {
    const name = `${row.card_name} [${row.raw_import.raw_row.エキスパンション}]`;
    const id = `TOKYO_${sha256(['oripark-source-edition-v1', row.franchise, 'PSA10', 'kecak', row.excel_product_id])}`;
    const origin = { source: 'kecak', id: row.excel_product_id, franchise: row.franchise, name, modelNumber: row.list_no, productType: 'PSA10', sourcePrice: 10000,
      observedAt: '2026-11-19T00:00:00+09:00', rawPrice: 10000, highRate: 0.1, highPrice: 9000, lowRate: 0.2, lowPrice: 8000 };
    products.push({ id, franchise: row.franchise, product_type: 'psa', name, model_number: row.list_no, image_url: row.image_url,
      source_price: 10000, price_high: 9000, price_low: 8000, selected_high_source: 'kecak', selected_low_source: 'kecak', origins: [origin] });
    priceSources[id] = { source: 'kecak', source_id: row.excel_product_id, price: 10000 };
    cards.push({ source_shinsoku_id: id, franchise: row.franchise, card_name: name, list_no: row.list_no, grade: 'PSA10', price_high: 9000, price_low: 8000, image_url: row.image_url });
    coverage.items.push({ oriparkCardId: row.id, productId: id, imageUrl: row.image_url, altImageUrl: null, tag: row.tag, rarity: null,
      edition: { sourceProductId: row.excel_product_id, name, expansion: row.raw_import.raw_row.エキスパンション } });
  }
  return { input, result: { products, cards, coverage, priceSources } };
}
test('upstream replay permits evidenced separate editions while preserving unrelated products', () => {
  const { input, result } = coverageCase();
  assert.deepEqual(assertCoverageOutput(input, result), { products: 3, prepared: 3, coverage: 2, originalProducts: 1, supplemented: 2 });
});
for (const [name, mutate, reason] of [
  ['unrelated name', c => { c.result.products[0].name = '別の名前'; }, /EXISTING_PRODUCT_CHANGED/],
  ['edition image', c => { c.result.coverage.items[0].imageUrl = c.result.coverage.items[1].imageUrl; }, /EDITION_EVIDENCE_CHANGED/],
  ['source raw price', c => { c.result.products[1].source_price++; }, /SUPPLEMENT_ID_PRICE_OR_ORIGIN_CHANGED/],
  ['collapsed source IDs', c => { c.result.coverage.items[1].productId = c.result.coverage.items[0].productId; }, /EDITION_PRODUCT_COLLISION/],
  ['missing published row', c => { c.result.coverage.items.pop(); }, /BASELINE_COVERAGE_CHANGED/],
]) test(`upstream replay rejects ${name}`, () => {
  const c = coverageCase(); mutate(c); assert.throws(() => assertCoverageOutput(c.input, c.result), reason);
});
