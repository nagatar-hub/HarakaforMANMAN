import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateTokyoReviewManifest, prepareTokyoReviewedImageImport, mappingSetSnapshot, verifyExistingMappingSet } from '../scripts/import-tokyo-reviewed-images';

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const candidate = { provider: 'haraka', id: '11111111-1111-1111-1111-111111111111', image: 'https://www.pokemon-card.com/assets/images/a.png' };
  const item = { id: 'psa-1', franchise: 'Pokemon', name: 'テスト', model_number: '001/001', product_type: 'psa', sourceImage: 'source', candidates: [candidate] };
  const source_dataset = { items: [item], datasetId: hash(JSON.stringify([{ ...item, candidates: [{ id: candidate.id, image: candidate.image }] }])) };
  const decision = { status: 'adopt', candidateId: candidate.id, provider: 'haraka', no_sample: true, no_slab: true, variant_confirmed: true, note: '', at: '2026-09-07T00:00:00Z' };
  const baseline = { kind: 'tcgmp_image_review_v1', dataset_id: source_dataset.datasetId, decisions: { 'psa-1': decision } };
  const additional_dataset = { items: [], baseline, datasetId: hash(JSON.stringify({ items: [], baseline })) };
  const additional = { kind: 'additional_image_review_v1', dataset_id: additional_dataset.datasetId, baseline, candidates: [], decisions: {} };
  const row = { source_shinsoku_id: item.id, franchise: item.franchise, product_type: item.product_type, name: item.name, model_number: item.model_number,
    provider: 'haraka', provider_product_id: candidate.id, source_url: candidate.image, verified_at: decision.at,
    evidence: { no_sample: true, no_slab: true, variant_confirmed: true, note: 'Synthetic user confirmation fixture' } };
  return { kind: 'tokyo_reviewed_image_manifest_v1', source_dataset, additional_dataset, baseline, additional, mappings: [row] };
}

function boxFixture() {
  const d: any = fixture(), item = d.source_dataset.items[0], mapping = d.mappings[0];
  item.id = 'box-1'; item.name = '[1BOX]25th ゴールデンボックス'; item.model_number = null; item.product_type = 'box';
  mapping.source_shinsoku_id = item.id; mapping.product_type = 'box'; mapping.name = item.name; mapping.model_number = null;
  d.baseline.decisions = { [item.id]: d.baseline.decisions['psa-1'] };
  d.source_dataset.datasetId = hash(JSON.stringify([{ ...item, candidates: item.candidates.map((candidate: any) => ({ id: candidate.id, image: candidate.image })) }]));
  d.baseline.dataset_id = d.source_dataset.datasetId;
  d.additional_dataset.baseline = d.baseline; d.additional.baseline = d.baseline;
  d.additional_dataset.datasetId = hash(JSON.stringify({ items: [], baseline: d.baseline }));
  d.additional.dataset_id = d.additional_dataset.datasetId;
  return d;
}

function nullModelOnphalosFixture() {
  const d: any = fixture(), item = d.source_dataset.items[0], mapping = d.mappings[0];
  item.model_number = null; item.candidates = [];
  d.source_dataset.datasetId = hash(JSON.stringify([{ ...item, candidates: [] }]));
  d.baseline.dataset_id = d.source_dataset.datasetId;
  d.baseline.decisions['psa-1'] = { status: 'hold', note: 'pixel proof pending', at: '2026-09-07T00:00:00Z' };
  const candidate = { key: 'onphalos:123', id: '123', image: 'https://www.pokemon-card.com/assets/images/card_images/a.png' };
  d.additional_dataset.items = [{ id: 'psa-1', candidates: [candidate] }];
  d.additional.candidates = d.additional_dataset.items;
  d.additional.decisions = { 'psa-1': { status: 'adopt', candidateKey: candidate.key, no_sample: true, no_slab: true,
    variant_confirmed: true, pixel_exact: true, source_image_sha256: 'a'.repeat(64), note: 'pixel exact', at: '2026-09-07T01:00:00Z' } };
  d.additional_dataset.baseline = d.baseline; d.additional.baseline = d.baseline;
  d.additional_dataset.datasetId = hash(JSON.stringify({ items: d.additional_dataset.items, baseline: d.baseline }));
  d.additional.dataset_id = d.additional_dataset.datasetId;
  Object.assign(mapping, { model_number: null, provider: 'onphalos', provider_product_id: '123', source_url: candidate.image,
    sha256: 'a'.repeat(64), verified_at: '2026-09-07T01:00:00Z',
    evidence: { ...mapping.evidence, pixel_exact: true, source_image_sha256: 'a'.repeat(64) } });
  return d;
}

test('frozen candidate datasets -> explicit mapping; foreign ids, changed baseline, missing flags and partial import rejected', () => {
  expect(validateTokyoReviewManifest(fixture()).size).toBe(1);
  const patches: ((d: any) => void)[] = [
    d => { d.mappings = []; }, d => { d.mappings[0].provider_product_id = 'foreign'; },
    d => { d.mappings[0].source_url += '?changed'; }, d => { d.baseline.decisions['psa-1'].no_slab = false; },
    d => { d.additional.baseline = {}; }, d => { d.source_dataset.datasetId = 'changed'; },
    d => { d.mappings[0].model_number = '001/002'; }, d => { d.mappings.push(d.mappings[0]); },
  ];
  for (const patch of patches) { const d = fixture(); patch(d); expect(() => validateTokyoReviewManifest(d)).toThrow(); }
});

test('approved image bytes become provider-labeled Tokyo cache; altered file rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokyo-reviewed-test-'));
  try {
    const bytes = await sharp({ create: { width: 200, height: 280, channels: 3, background: '#fff' } }).png().toBuffer();
    const sha256 = hash(bytes), file = `${sha256}.png`, path = join(directory, 'manifest.json');
    const manifest = fixture(); Object.assign(manifest.mappings[0], { file, sha256 });
    await writeFile(path, JSON.stringify(manifest)); await writeFile(join(directory, file), bytes);
    const result = await prepareTokyoReviewedImageImport(path);
    expect(result.prepared[0].row).toMatchObject({ provider: 'haraka', tcgmp_product_id: null, tcgmp_sku: null, sha256 });
    expect(result.prepared[0].row.image_url).toContain(`/manman-akihabara/haraka/${file}`);
    await writeFile(join(directory, file), 'changed');
    await expect(prepareTokyoReviewedImageImport(path)).rejects.toThrow('checksum');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reviewed Haraka BOX with exact null model is accepted; non-Haraka BOX and ONPHALOS scope expansion are rejected', () => {
  expect(validateTokyoReviewManifest(boxFixture()).size).toBe(1);
  for (const provider of ['tcgmp', 'onphalos']) {
    const d: any = boxFixture();
    d.source_dataset.items[0].candidates[0].provider = provider;
    d.baseline.decisions['box-1'].provider = provider;
    d.mappings[0].provider = provider;
    expect(() => validateTokyoReviewManifest(d)).toThrow();
  }
  const pokemonPsa: any = fixture();
  pokemonPsa.source_dataset.items[0].franchise = 'ONE PIECE'; pokemonPsa.mappings[0].franchise = 'ONE PIECE';
  pokemonPsa.source_dataset.items[0].candidates = [];
  pokemonPsa.baseline.decisions['psa-1'].status = 'none';
  const official = { key: 'onphalos:123', id: '123', image: 'https://www.pokemon-card.com/assets/images/card_images/a.png' };
  pokemonPsa.additional_dataset.items = [{ id: 'psa-1', candidates: [official] }]; pokemonPsa.additional.candidates = pokemonPsa.additional_dataset.items;
  pokemonPsa.additional.decisions = { 'psa-1': { status: 'adopt', candidateKey: official.key, no_sample: true, no_slab: true,
    variant_confirmed: true, note: '', at: '2026-09-07T01:00:00Z' } };
  pokemonPsa.mappings[0].provider = 'onphalos'; pokemonPsa.mappings[0].provider_product_id = '123'; pokemonPsa.mappings[0].source_url = official.image;
  pokemonPsa.source_dataset.datasetId = hash(JSON.stringify(pokemonPsa.source_dataset.items.map((p: any) => ({
    id: p.id, franchise: p.franchise, name: p.name, model_number: p.model_number, product_type: p.product_type,
    sourceImage: p.sourceImage, harakaMatch: p.harakaMatch, candidates: [],
  }))));
  pokemonPsa.baseline.dataset_id = pokemonPsa.source_dataset.datasetId;
  pokemonPsa.additional_dataset.baseline = pokemonPsa.baseline; pokemonPsa.additional.baseline = pokemonPsa.baseline;
  pokemonPsa.additional_dataset.datasetId = hash(JSON.stringify({ items: pokemonPsa.additional_dataset.items, baseline: pokemonPsa.baseline }));
  pokemonPsa.additional.dataset_id = pokemonPsa.additional_dataset.datasetId;
  expect(() => validateTokyoReviewManifest(pokemonPsa)).toThrow('unsupported');
});

test('null-model ONPHALOS Pokemon PSA requires manifest-bound pixel-exact equal hashes', () => {
  expect(validateTokyoReviewManifest(nullModelOnphalosFixture()).size).toBe(1);
  for (const patch of [
    (d: any) => { d.mappings[0].evidence.pixel_exact = false; },
    (d: any) => { d.mappings[0].evidence.source_image_sha256 = 'b'.repeat(64); },
    (d: any) => { d.additional.decisions['psa-1'].pixel_exact = false; },
    (d: any) => { d.additional.decisions['psa-1'].source_image_sha256 = 'b'.repeat(64); },
  ]) { const d = nullModelOnphalosFixture(); patch(d); expect(() => validateTokyoReviewManifest(d)).toThrow(); }
});

test('additional official selection is bound to its own candidate and cannot overwrite baseline adoption', () => {
  const d: any = fixture();
  const product = { ...d.source_dataset.items[0], id: 'psa-2', candidates: [] };
  d.source_dataset.items.push(product);
  d.source_dataset.datasetId = hash(JSON.stringify(d.source_dataset.items.map((p: any) => ({ ...p,
    candidates: p.candidates.map((c: any) => ({ id: c.id, image: c.image })) }))));
  d.baseline.dataset_id = d.source_dataset.datasetId;
  d.baseline.decisions['psa-2'] = { status: 'hold', note: 'Awaiting image', at: '2026-09-07T00:00:00Z' };
  const c = { key: 'onphalos:123', id: '123', image: 'https://www.pokemon-card.com/assets/images/card_images/large/WCP/004010_P_BUSUTA.gif' };
  const extra = { id: 'psa-2', candidates: [c] };
  d.additional_dataset.items = [extra]; d.additional.candidates = [extra];
  d.additional_dataset.datasetId = hash(JSON.stringify({ items: [extra], baseline: d.baseline }));
  d.additional.dataset_id = d.additional_dataset.datasetId;
  d.additional.decisions['psa-2'] = { status: 'adopt', candidateKey: c.key, no_sample: true, no_slab: true, variant_confirmed: true, note: '', at: '2026-09-07T01:00:00Z' };
  d.mappings.push({ ...d.mappings[0], source_shinsoku_id: 'psa-2', provider: 'onphalos', provider_product_id: c.id, source_url: c.image, verified_at: '2026-09-07T01:00:00Z' });
  expect(validateTokyoReviewManifest(d).size).toBe(2);
  const rehash = () => {
    const projected = d.source_dataset.items.map((p: any) => ({
      id: p.id, franchise: p.franchise, name: p.name, model_number: p.model_number, product_type: p.product_type,
      sourceImage: p.sourceImage, harakaMatch: p.harakaMatch,
      candidates: p.candidates.map((candidate: any) => ({ id: candidate.id, image: candidate.image })),
    }));
    d.source_dataset.datasetId = hash(JSON.stringify(projected));
    d.baseline.dataset_id = d.source_dataset.datasetId;
    d.additional_dataset.datasetId = hash(JSON.stringify({ items: [extra], baseline: d.baseline }));
    d.additional.dataset_id = d.additional_dataset.datasetId;
  };
  product.franchise = 'ONE PIECE'; d.mappings[1].franchise = 'ONE PIECE'; rehash();
  expect(() => validateTokyoReviewManifest(d)).toThrow('unsupported');
  product.franchise = 'Pokemon'; d.mappings[1].franchise = 'Pokemon'; rehash();
  d.additional.decisions['psa-2'].candidateKey = 'onphalos:999';
  expect(() => validateTokyoReviewManifest(d)).toThrow('Foreign');
  d.additional.decisions['psa-2'].candidateKey = c.key;
  d.baseline.decisions['psa-2'].status = 'adopt';
  d.additional_dataset.datasetId = hash(JSON.stringify({ items: [extra], baseline: d.baseline }));
  d.additional.dataset_id = d.additional_dataset.datasetId;
  expect(() => validateTokyoReviewManifest(d)).toThrow();
});

test('frozen existing mapping set rejects additions, updates and deletions between race checks', async () => {
  const row: any = { source_shinsoku_id: 'psa-1', franchise: 'Pokemon', name: 'テスト', model_number: '001/001',
    provider: 'onphalos', provider_product_id: '123', tcgmp_product_id: null, tcgmp_sku: null, image_url: 'https://cache/1.jpg',
    sha256: 'a'.repeat(64), verified_at: '2026-09-08T00:00:00Z', evidence: {} };
  let rows = [row];
  const db: any = { from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }) };
  const frozen = mappingSetSnapshot(rows);
  await expect(verifyExistingMappingSet(db, ['psa-1'], frozen)).resolves.toBeUndefined();
  for (const changed of [[row, { ...row, source_shinsoku_id: 'psa-2' }], [{ ...row, name: '変更' }], []]) {
    rows = changed;
    await expect(verifyExistingMappingSet(db, ['psa-1'], frozen)).rejects.toThrow('set changed');
  }
});
