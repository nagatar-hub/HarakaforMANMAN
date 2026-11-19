import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { calculateBoxPriceHigh, calculateBuyPriceHigh, postalProductIdentity, tokyoBoxAliasName } from '@haraka/shared';
import { sha256, validatePrepareFixture } from './recovery.mjs';

// Keep this file from the trusted controller revision, never the candidate checkout.
// The caller runs it in a container with no network, credentials, writable fixture or host mounts.
// Candidate code is a separate process: process.exit(0) cannot skip these acceptance checks.
const WORKER = `
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const {stage,runId,input}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const before=JSON.stringify(input);
let result;
try {
  if(stage==='coverage_prepare') {
    const coverageModule=await import(pathToFileURL(resolve(process.argv[1],'packages/job/dist/lib/oripark-coverage.js')).href);
    const comparisonModule=await import(pathToFileURL(resolve(process.argv[1],'packages/job/dist/jobs/tokyo-buyback-sync.js')).href);
    const preparedModule=await import(pathToFileURL(resolve(process.argv[1],'packages/job/dist/lib/tokyo-normal-cards.js')).href);
    const comparison=structuredClone(input.preCoverage),settings=input.snapshot.settings;
    const coverage=coverageModule.completeOriparkCoverage(comparison,input.baseline,input.snapshot.business_date,
      settings.tokyo_price_max_age_days,candidate=>comparisonModule.compareTokyoSourceProducts([candidate],[],settings,input.snapshot.fetched_at));
    const snapshot={...input.snapshot,report:{...input.snapshot.report,price_sources:comparison.priceSources,oripark_coverage:coverage}};
    const cards=preparedModule.buildTokyoPreparedCards(runId,{snapshot,products:comparison.products},input.imageMappings,input.dbCards);
    result={products:comparison.products,priceSources:comparison.priceSources,coverage,cards};
  } else if(stage==='prepare') {
    const module=await import(pathToFileURL(resolve(process.argv[1],'packages/job/dist/lib/tokyo-normal-cards.js')).href);
    result=module.buildTokyoPreparedCards(runId,{snapshot:input.snapshot,products:input.products},input.imageMappings,input.dbCards);
  } else {
    const module=await import(pathToFileURL(resolve(process.argv[1],'packages/job/dist/jobs/generate.js')).href);
    result=module.planTokyoGalleryPages(input.cards,input.layouts,input.rules);
  }
  process.stdout.write(JSON.stringify({outcome:'success',result,inputUnchanged:before===JSON.stringify(input)}));
} catch(error) {
  process.stdout.write(JSON.stringify({outcome:'error',errorSha256:hash(error instanceof Error?error.message:String(error))}));
}
`;

const sameIds = (a, b) => {
  if (new Set(a).size !== a.length || new Set(b).size !== b.length || a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((id, index) => id === sorted[index]);
};
const assert = (ok, code) => { if (!ok) throw new Error(code); };

export function assertPrepareOutput(input, cards) {
  assert(Array.isArray(cards) && cards.length > 0, 'PREPARED_EMPTY');
  assert(sameIds(input.products.map(p => p.id), cards.map(c => c.source_shinsoku_id)), 'PRODUCT_IDS_CHANGED');
  const byId = new Map(cards.map(card => [card.source_shinsoku_id, card]));
  for (const product of input.products) {
    const card = byId.get(product.id);
    assert(card.card_name === product.name && card.franchise === product.franchise && card.list_no === product.model_number, 'PRODUCT_IDENTITY_CHANGED');
    assert(Number.isSafeInteger(product.price_high) && product.price_high > 0 && Number.isSafeInteger(product.price_low)
      && product.price_low >= 0 && product.price_low <= product.price_high
      && card.price_high === product.price_high && card.price_low === product.price_low, 'IMMUTABLE_PRICE_CHANGED');
    assert(card.grade === (product.product_type === 'box' ? '未開封BOX' : 'PSA10'), 'PRODUCT_TYPE_CHANGED');
    // Requiring existing exact image evidence prevents a guard-removal patch from choosing a random edition.
    const coverage = input.snapshot.report?.oripark_coverage?.items?.filter(item => item.productId === product.id) ?? [];
    if (coverage.length) {
      assert(new Set(coverage.map(item => item.imageUrl)).size === 1, 'AMBIGUOUS_COVERAGE_EVIDENCE');
      assert(card.image_url || card.alt_image_url, 'COVERAGE_IMAGE_MISSING');
      const edition = coverage[0].edition;
      if (edition) assert(product.name === edition.name && card.image_url === coverage[0].imageUrl
        && product.origins.some(origin => origin.source === 'kecak' && origin.id === edition.sourceProductId), 'EDITION_IMAGE_CHANGED');
    }
  }
  const coverage = input.snapshot.report?.oripark_coverage?.items ?? [];
  assert(coverage.every(item => byId.has(item.productId)), 'COVERAGE_PRODUCT_MISSING');
  return { products: input.products.length, prepared: cards.length, coverage: coverage.length };
}

export function assertPlanOutput(input, plans) {
  assert(Array.isArray(plans) && plans.length > 0, 'PLANS_EMPTY');
  assert(sameIds(input.cards.map(card => card.id), plans.flatMap(plan => plan.cardIds ?? [])), 'PLANNED_CARD_COVERAGE');
  for (const plan of plans) {
    const layout = input.layouts.find(row => row.id === plan.layoutTemplateId && row.is_active);
    assert(layout && Number.isSafeInteger(layout.total_slots) && layout.total_slots > 0
      && plan.cardIds.length <= layout.total_slots && plan.cardIds.length > 0, 'LAYOUT_CAPACITY');
    const cards = plan.cardIds.map(id => input.cards.find(card => card.id === id));
    const types = new Set(cards.map(card => card.tag === 'BOX' || ['BOX', '未開封BOX'].includes(card.grade)));
    assert(types.size === 1 && layout.slug.startsWith('box_') === types.has(true), 'LAYOUT_PRODUCT_TYPE');
    assert(new Set(cards.map(card => card.franchise)).size === 1, 'MIXED_FRANCHISE');
  }
  return { cards: input.cards.length, pages: plans.length };
}

const productType = row => row.tag === 'BOX' || /BOX/i.test(row.grade ?? '') ? 'BOX' : 'PSA10';
const cardIdentity = row => postalProductIdentity({ franchise: row.franchise, name: tokyoBoxAliasName(row), modelNumber: row.modelNumber, productType: row.productType });
const baselineKeys = card => [card.card_name, card.db_card?.card_name].filter(Boolean).map(name => cardIdentity({
  franchise: card.franchise, name, modelNumber: card.list_no, productType: productType(card) }));
const exactSource = (card, product) => card.source === 'order_list' && card.excel_product_id
  && product.franchise === card.franchise && product.product_type === (productType(card) === 'BOX' ? 'box' : 'psa')
  && product.origins.some(origin => origin.source === 'kecak' && origin.id === card.excel_product_id);
function authorizedEdition(card, input) {
  const keys = baselineKeys(card);
  const peers = input.baseline.cards.filter(other => baselineKeys(other).some(key => keys.includes(key)));
  const image = row => row.raw_import?.raw_row?.['画像'] || row.image_url;
  const expansion = row => row.raw_import?.raw_row?.['エキスパンション']?.trim();
  if (peers.length < 2 || new Set(peers.map(row => row.excel_product_id)).size < 2
    || new Set(peers.map(image)).size < 2 || peers.some(row => row.source !== 'order_list' || productType(row) !== 'PSA10'
      || !row.excel_product_id || row.raw_import?.price_source !== 'order_list' || !expansion(row)
      || row.raw_import.raw_row['商品ID'] != null && row.raw_import.raw_row['商品ID'] !== row.excel_product_id
      || !image(row)?.startsWith('https://'))) return null;
  const mapped = peers.map(row => {
    const exact = input.preCoverage.products.filter(product => exactSource(row, product));
    if (exact.length === 1) return exact;
    const expected = baselineKeys(row);
    return input.preCoverage.products.filter(product => [cardIdentity({ franchise: product.franchise, name: product.name,
      modelNumber: product.model_number, productType: product.product_type === 'box' ? 'BOX' : 'PSA10' }),
      ...product.origins.map(cardIdentity)].some(key => expected.includes(key)));
  });
  // Already distinct products are not part of the repair. In particular, preserve comic/wanted-poster labels.
  if (mapped.every(matches => matches.length === 1) && new Set(mapped.map(matches => matches[0].id)).size === peers.length) return null;
  const shared = peers.some(other => other.excel_product_id !== card.excel_product_id && expansion(other) === expansion(card));
  const short = peers.some(other => other.excel_product_id !== card.excel_product_id
    && other.excel_product_id.slice(0, 8) === card.excel_product_id.slice(0, 8)) ? card.excel_product_id : card.excel_product_id.slice(0, 8);
  return { sourceProductId: card.excel_product_id, expansion: expansion(card),
    name: `${card.card_name} [${expansion(card)}${shared ? ` / 元商品ID:${short}` : ''}]`, imageUrl: image(card) };
}
function singleSourceProduct(candidate, input) {
  const settings = input.snapshot.settings, rates = settings.tokyo_source_discount_rates[candidate.source];
  assert(rates && Number.isSafeInteger(candidate.sourcePrice) && candidate.sourcePrice > 0
    && candidate.sourcePrice <= settings.tokyo_outlier_guard.max_source_price
    && [rates.high, rates.low].every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 1), 'SOURCE_PRICE_INVALID');
  const display = rate => candidate.productType === 'BOX' ? calculateBoxPriceHigh(candidate.sourcePrice, rate)
    : Math.floor(calculateBuyPriceHigh(candidate.sourcePrice, rate) / 1000) * 1000;
  const high = display(rates.high), low = display(rates.low);
  assert(high > 0 && low >= 0 && low <= high, 'SOURCE_PRICE_INVALID');
  const origin = { ...candidate, rawPrice: candidate.sourcePrice, highRate: rates.high, highPrice: high, lowRate: rates.low, lowPrice: low };
  return { id: candidate.source === 'shinsoku' ? candidate.id : `TOKYO_${sha256(cardIdentity(candidate))}`,
    franchise: candidate.franchise, product_type: candidate.productType === 'BOX' ? 'box' : 'psa',
    name: tokyoBoxAliasName(candidate), model_number: candidate.modelNumber, image_url: null,
    source_price: candidate.sourcePrice, price_high: high, price_low: low, selected_high_source: candidate.source,
    selected_low_source: candidate.source, origins: [origin] };
}

/** Acceptance belongs to the trusted harness, including pricing and collateral-name checks. */
export function assertCoverageOutput(input, result) {
  const { products, coverage, cards, priceSources } = result ?? {};
  assert(Array.isArray(products) && new Set(products.map(p => p.id)).size === products.length
    && Array.isArray(coverage?.items) && sameIds(input.baseline.cards.map(c => c.id), coverage.items.map(c => c.oriparkCardId)), 'BASELINE_COVERAGE_CHANGED');
  assert(coverage.runId === input.baseline.runId && coverage.businessDate === input.baseline.businessDate
    && coverage.fingerprint === input.baseline.fingerprint, 'BASELINE_IDENTITY_CHANGED');
  const original = new Map(input.preCoverage.products.map(p => [p.id, p]));
  const byId = new Map(products.map(p => [p.id, p]));
  const editionByProduct = new Map();
  const newExpected = new Map();
  for (const card of input.baseline.cards) {
    const item = coverage.items.find(item => item.oriparkCardId === card.id), product = byId.get(item.productId);
    assert(product && product.franchise === card.franchise && product.product_type === (productType(card) === 'BOX' ? 'box' : 'psa'), 'COVERAGE_PRODUCT_INVALID');
    const edition = authorizedEdition(card, input);
    if (edition) {
      assert(isDeepStrictEqual(item.edition, { sourceProductId: edition.sourceProductId, expansion: edition.expansion, name: edition.name })
        && item.imageUrl === edition.imageUrl && item.altImageUrl === null, 'EDITION_EVIDENCE_CHANGED');
      const prior = editionByProduct.get(item.productId);
      assert(!prior || prior.sourceProductId === edition.sourceProductId, 'EDITION_PRODUCT_COLLISION');
      editionByProduct.set(item.productId, edition);
    } else assert(!item.edition && item.imageUrl === (card.image_url || card.alt_image_url), 'UNRELATED_EDITION_CHANGED');
    if (!original.has(product.id)) {
      const age = (Date.parse(input.snapshot.business_date) - Date.parse(input.baseline.businessDate)) / 86400000;
      assert(Number.isInteger(age) && age >= 0 && age <= input.snapshot.settings.tokyo_price_max_age_days, 'SOURCE_PRICE_STALE');
      const override = productType(card) === 'BOX' ? card.raw_import?.raw_row?.pokemon_box_price_source : null;
      assert(override == null || override === 'BOX_PRICE_DB', 'SOURCE_PRICE_INVALID');
      const source = override === 'BOX_PRICE_DB' ? 'shinsoku' : card.raw_import?.price_source === 'order_list' ? 'kecak' : card.raw_import?.price_source;
      assert(['kecak', 'shinsoku', 'extoreca'].includes(source) && card.excel_product_id, 'SOURCE_PRICE_INVALID');
      const expected = singleSourceProduct({ source, id: card.excel_product_id, franchise: card.franchise,
        name: edition?.name ?? card.card_name, modelNumber: card.list_no, productType: productType(card),
        sourcePrice: card.raw_import.source_price, observedAt: `${input.baseline.businessDate}T00:00:00+09:00` }, input);
      if (edition) {
        expected.id = `TOKYO_${sha256(['oripark-source-edition-v1', card.franchise, productType(card), source, card.excel_product_id])}`;
        expected.name = edition.name; expected.image_url = edition.imageUrl;
      }
      assert(isDeepStrictEqual(expected, product), 'SUPPLEMENT_ID_PRICE_OR_ORIGIN_CHANGED');
      newExpected.set(product.id, expected);
    }
  }
  for (const [id, previous] of original) {
    const product = byId.get(id), edition = editionByProduct.get(id);
    let expected = previous;
    if (edition) {
      const own = previous.origins.filter(origin => origin.source === 'kecak' && origin.id === edition.sourceProductId);
      assert(own.length === 1, 'ORIGINAL_EDITION_SOURCE_MISSING');
      if (own.length !== previous.origins.length) expected = { ...singleSourceProduct({ source: own[0].source, id: own[0].id,
        franchise: own[0].franchise, name: edition.name, modelNumber: own[0].modelNumber, productType: own[0].productType,
        observedAt: own[0].observedAt, sourcePrice: own[0].rawPrice }, input), id };
      expected = { ...expected, name: edition.name, image_url: edition.imageUrl };
    }
    assert(isDeepStrictEqual(expected, product), 'EXISTING_PRODUCT_CHANGED');
  }
  assert(products.length === original.size + newExpected.size, 'UNPROVEN_PRODUCT_ADDED');
  for (const product of products) {
    const selected = product.origins.find(origin => origin.source === product.selected_high_source);
    assert(selected && priceSources?.[product.id]?.source === selected.source && priceSources[product.id].source_id === selected.id
      && priceSources[product.id].price === product.source_price, 'PRICE_PROVENANCE_CHANGED');
  }
  const prepared = assertPrepareOutput({ ...input, products, snapshot: { ...input.snapshot,
    report: { ...input.snapshot.report, oripark_coverage: coverage } } }, cards);
  return { ...prepared, originalProducts: original.size, supplemented: newExpected.size };
}

export function evaluateReplay(fixture, result, mode) {
  validatePrepareFixture(fixture);
  if (mode === 'baseline') {
    assert(result?.outcome === 'error' && result.errorSha256 === fixture.errorSha256, 'BASELINE_DID_NOT_REPRODUCE');
    return { exitCode: 10, outcome: 'reproduced', stage: fixture.stage, inputSha256: sha256(fixture.input) };
  }
  assert(mode === 'candidate', 'INVALID_MODE');
  assert(result?.outcome === 'success' && result.inputUnchanged === true, 'CANDIDATE_FAILED_OR_MUTATED_INPUT');
  const counts = fixture.stage === 'coverage_prepare' ? assertCoverageOutput(fixture.input, result.result)
    : fixture.stage === 'prepare' ? assertPrepareOutput(fixture.input, result.result) : assertPlanOutput(fixture.input, result.result);
  return { exitCode: 0, outcome: 'accepted', stage: fixture.stage, inputSha256: sha256(fixture.input), counts };
}

export function runReplay(fixture, candidateRepo, mode = 'candidate') {
  validatePrepareFixture(fixture);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', WORKER, resolve(candidateRepo)], {
    cwd: resolve(candidateRepo), input: JSON.stringify({ stage: fixture.stage, runId: fixture.runId, input: fixture.input }),
    encoding: 'utf8', timeout: 120000, maxBuffer: 25 * 1024 * 1024,
    // Do not inherit service keys, metadata credentials, Node preload hooks or proxy variables.
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', NODE_ENV: 'test', STORE_NAME: 'manman-akihabara' },
    windowsHide: true,
  });
  assert(!child.error && child.status === 0, 'CANDIDATE_PROCESS_FAILED');
  let result;
  try { result = JSON.parse(child.stdout); } catch { throw new Error('CANDIDATE_RESULT_INVALID'); }
  return evaluateReplay(fixture, result, mode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv[2] && process.argv[3], 'FIXTURE_AND_REPOSITORY_REQUIRED');
    const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    const result = runReplay(fixture, process.argv[3], process.argv[4] ?? 'candidate');
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'rejected', reason: error instanceof Error ? error.message : 'REPLAY_FAILED' }));
    process.exitCode = 1;
  }
}
