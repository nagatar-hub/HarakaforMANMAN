import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { normalizeStorePricingSettings } from '@haraka/shared';
import { prepareTokyoCardrushImages } from '../lib/tokyo-cardrush-images';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';
import { acceptsTagEvidenceBackfill } from '../scripts/import-tokyo-cardrush-images';

let directory: string;
let manifest: any;
const product = { id: 'IAX1', franchise: 'YU-GI-OH!', name: '千年原人(初期)', model_number: null, product_type: 'psa' };
const onePieceProduct = { id: 'OPX1', franchise: 'ONE PIECE', name: 'サカズキ', model_number: 'OP02-099', product_type: 'psa' };
const pokemonProduct = { id: 'PKX1', franchise: 'Pokemon', name: 'ミュウツーGX', model_number: '080/072', product_type: 'psa' };
const onePieceBox = { id: 'OPBOX1', franchise: 'ONE PIECE', name: '[1BOX]THE BEST', model_number: null, product_type: 'box' };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'haraka-cardrush-test-'));
  await mkdir(join(directory, 'accepted'));
  const bytes = await sharp({ create: { width: 10, height: 15, channels: 3, background: 'white' } }).png().toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'accepted', hash + '.png'), bytes);
  manifest = { kind: 'tokyo_cardrush_image_review_v1', store: 'manman-akihabara', verified_at: '2026-09-08T00:00:00Z', products: [{
    source_shinsoku_id: product.id, name: product.name, model_number: null, product_type: 'psa', provider: 'cardrush',
    status: 'assistant_verified', verified_by: 'assistant', user_approved: false, note: 'Test fixture only, not an actual visual approval',
    no_sample: true, no_slab: true, variant_confirmed: true, visual_identity_verified: true,
    verification_method: 'source_sha256_equal', source_sha256_equal: true,
    cardrush_product_id: '102181', page_url: 'https://www.cardrush.jp/product/102181',
    image_url: 'https://www.cardrush.jp/data/cardrush/product/example.png', sha256: hash, source_image_sha256: hash, file: `accepted/${hash}.png`,
  }] };
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

test('local prepared mapping keeps assistant provenance and exact null-model identity through normal mapper', async () => {
  const [{ row, bytes }] = await prepareTokyoCardrushImages(manifest, directory, [product]);
  expect(bytes.length).toBeGreaterThan(0);
  expect(row).toMatchObject({ provider: 'cardrush', model_number: null, tcgmp_product_id: null,
    evidence: { verified_by: 'assistant', user_approved: false, no_sample: true, no_slab: true, source_sha256_equal: true } });
  const snapshot: any = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-08', settings: normalizeStorePricingSettings({}) }, products: [
    { ...product, price_high: 9300, image_url: 'https://example.com/slab.jpg' },
    { ...product, id: 'box', product_type: 'box', source_price: 20000, price_high: 18600, image_url: 'https://example.com/box.jpg' },
  ] };
  const before = buildTokyoPreparedCards('run', snapshot);
  expect(buildTokyoPreparedCards('run', snapshot, [row])).toEqual([{ ...before[0], image_url: row.image_url }, before[1]]);
  for (const patch of [{ name: 'different' }, { model_number: 'different' }, { franchise: 'Pokemon' }, { image_url: row.image_url.replace('/cardrush/', '/tcgmp/') }]) {
    expect(buildTokyoPreparedCards('run', snapshot, [{ ...row, ...patch } as any])[0].image_url).toBeNull();
  }
});

test('accepts ONE PIECE only from cardrush-op and keeps the same storage mapping semantics', async () => {
  const onePieceManifest = { ...manifest, products: [{ ...manifest.products[0],
    source_shinsoku_id: onePieceProduct.id, name: onePieceProduct.name, model_number: onePieceProduct.model_number,
    tag: 'コミパラ', source_title: 'サカズキ(パラレル/漫画背景/漫画絵)【SR/SP】{OP02-099}',
    cardrush_product_id: '2955', page_url: 'https://www.cardrush-op.jp/product/2955',
    image_url: 'https://www.cardrush-op.jp/data/cardrush-op/product/example.png',
  }] };
  const [{ row, path }] = await prepareTokyoCardrushImages(onePieceManifest, directory, [onePieceProduct]);
  expect(row).toMatchObject({ franchise: 'ONE PIECE', provider: 'cardrush', provider_product_id: '2955',
    evidence: { tag: 'コミパラ', source_title: expect.stringContaining('サカズキ') } });
  expect(path).toContain('/manman-akihabara/cardrush/');
  await expect(prepareTokyoCardrushImages({ ...onePieceManifest, products: [{ ...onePieceManifest.products[0],
    image_url: 'https://www.cardrush-op.jp/phone/data/cardrush-op/product/example.png',
  }] }, directory, [onePieceProduct])).resolves.toHaveLength(1);

  for (const [review, source] of [
    [{ ...manifest, products: [{ ...manifest.products[0], page_url: 'https://www.cardrush-op.jp/product/102181',
      image_url: 'https://www.cardrush-op.jp/data/cardrush-op/product/example.png' }] }, product],
    [{ ...onePieceManifest, products: [{ ...onePieceManifest.products[0], page_url: 'https://www.cardrush.jp/product/2955',
      image_url: 'https://www.cardrush.jp/data/cardrush/product/example.png' }] }, onePieceProduct],
  ] as const) {
    await expect(prepareTokyoCardrushImages(review, directory, [source])).rejects.toThrow();
  }
  const pokemonManifest = { ...manifest, products: [{ ...manifest.products[0], source_shinsoku_id: pokemonProduct.id,
    name: pokemonProduct.name, model_number: pokemonProduct.model_number, cardrush_product_id: '1503',
    page_url: 'https://www.cardrush-pokemon.jp/product/1503',
    image_url: 'https://www.cardrush-pokemon.jp/data/cardrushpokemon/product/example.jpeg' }] };
  await expect(prepareTokyoCardrushImages(pokemonManifest, directory, [pokemonProduct])).resolves.toHaveLength(1);
  await expect(prepareTokyoCardrushImages({ ...pokemonManifest, products: [{ ...pokemonManifest.products[0], model_number: null }] },
    directory, [{ ...pokemonProduct, model_number: null }])).rejects.toThrow('source identity');
  for (const patch of [{ tag: undefined }, { tag: 'PSA10' }, { source_title: '' }, { source_title: 'x'.repeat(1001) }]) {
    await expect(prepareTokyoCardrushImages({ ...onePieceManifest, products: [{ ...onePieceManifest.products[0], ...patch }] }, directory, [onePieceProduct]))
      .rejects.toThrow('ONE PIECE tag evidence');
  }
});

test('reviewed ONE PIECE Cardrush BOX mapping is accepted and preferred only for exact BOX identity', async () => {
  const box = { id: 'OPBOX1', franchise: 'ONE PIECE', name: '謀略の王国', model_number: null, product_type: 'box' };
  const boxManifest = { ...manifest, products: [{ ...manifest.products[0], source_shinsoku_id: box.id,
    name: box.name, model_number: null, product_type: 'box', tag: 'BOX', cardrush_product_id: '9001',
    page_url: 'https://www.cardrush-op.jp/product/9001',
    image_url: 'https://www.cardrush-op.jp/data/cardrush-op/product/box.png',
  }] };
  const [{ row }] = await prepareTokyoCardrushImages(boxManifest, directory, [box]);
  expect(row).toMatchObject({ franchise: 'ONE PIECE', product_type: 'box', provider: 'cardrush', model_number: null });
  const source = { ...box, source_price: 20000, price_high: 18600, image_url: null };
  const snapshot: any = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-08', settings: normalizeStorePricingSettings({}) }, products: [source] };
  expect(buildTokyoPreparedCards('run', snapshot, [row])[0]).toMatchObject({ image_url: row.image_url, tag: 'BOX' });
  for (const patch of [{ name: '別BOX' }, { product_type: 'psa' }, { franchise: 'Pokemon' }]) {
    expect(buildTokyoPreparedCards('run', snapshot, [{ ...row, ...patch } as any])[0].image_url).toBeNull();
  }
});

test('reviewed ONE PIECE image tag splits pages without changing price or other franchises', async () => {
  const onePieceManifest = { ...manifest, products: [{ ...manifest.products[0],
    source_shinsoku_id: onePieceProduct.id, name: onePieceProduct.name, model_number: onePieceProduct.model_number,
    tag: 'コミパラ', source_title: 'サカズキ(パラレル/漫画背景/漫画絵)【SR/SP】{OP02-099}',
    cardrush_product_id: '2955', page_url: 'https://www.cardrush-op.jp/product/2955',
    image_url: 'https://www.cardrush-op.jp/data/cardrush-op/product/example.png',
  }] };
  const [{ row }] = await prepareTokyoCardrushImages(onePieceManifest, directory, [onePieceProduct]);
  const onePieceSnapshot: any = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-08', settings: normalizeStorePricingSettings({}) },
    products: [{ ...onePieceProduct, price_high: 12300, source_price: 13000, image_url: 'https://example.com/slab.jpg' }] };
  expect(buildTokyoPreparedCards('run', onePieceSnapshot, [row])[0]).toMatchObject({ tag: 'コミパラ', price_high: 12300, price_low: 12300 });
  expect(buildTokyoPreparedCards('run', onePieceSnapshot, [{ ...row,
    evidence: { ...row.evidence, source_title: '' } }])[0]).toMatchObject({ tag: 'PSA10', price_high: 12300 });
  expect(buildTokyoPreparedCards('run', { ...onePieceSnapshot, products: [{ ...onePieceSnapshot.products[0], franchise: 'Pokemon' }] },
    [{ ...row, franchise: 'Pokemon' } as any])[0]).toMatchObject({ tag: 'PSA10', price_high: 12300 });
});

test('accepts only a Tokyo ONE PIECE Cardrush BOX tagged BOX without PSA classification evidence', async () => {
  const boxManifest = { ...manifest, products: [{ ...manifest.products[0],
    source_shinsoku_id: onePieceBox.id, name: onePieceBox.name, product_type: 'box', tag: 'BOX',
    cardrush_product_id: '5140', page_url: 'https://www.cardrush-op.jp/product/5140',
    image_url: 'https://www.cardrush-op.jp/data/cardrush-op/product/example.png',
  }] };
  const [{ row }] = await prepareTokyoCardrushImages(boxManifest, directory, [onePieceBox]);
  expect(row).toMatchObject({ franchise: 'ONE PIECE', product_type: 'box', evidence: { tag: 'BOX' } });
  expect(row.evidence).not.toHaveProperty('source_title');
  for (const tag of [undefined, 'パラレル']) {
    await expect(prepareTokyoCardrushImages({ ...boxManifest, products: [{ ...boxManifest.products[0], tag }] }, directory, [onePieceBox]))
      .rejects.toThrow('ONE PIECE BOX tag evidence');
  }
});

test('production retry permits only an additive reviewed tag evidence backfill', () => {
  const base = { source_shinsoku_id: 'OPX1', verified_at: '2026-09-08T00:00:00Z', sha256: 'a'.repeat(64),
    evidence: { no_sample: true, note: 'reviewed' } };
  const tagged = { ...base, evidence: { ...base.evidence, tag: 'コミパラ', source_title: 'サカズキ【SR/SP】' } };
  expect(acceptsTagEvidenceBackfill(base, tagged)).toBe(true);
  expect(acceptsTagEvidenceBackfill(tagged, tagged)).toBe(true);
  expect(acceptsTagEvidenceBackfill({ ...tagged, evidence: { ...tagged.evidence, tag: 'キャラ' } }, tagged)).toBe(false);
  expect(acceptsTagEvidenceBackfill({ ...base, sha256: 'b'.repeat(64) }, tagged)).toBe(false);
  expect(acceptsTagEvidenceBackfill({ ...base, evidence: { ...base.evidence, note: 'changed' } }, tagged)).toBe(false);
});

test.each([
  { source_shinsoku_id: 'foreign' }, { name: 'different' }, { model_number: '' }, { product_type: 'box' },
  { status: 'hold' }, { user_approved: true }, { verified_by: 'user' }, { provider: 'haraka' },
  { no_sample: false }, { no_slab: false }, { variant_confirmed: false }, { visual_identity_verified: false }, { verification_method: 'unknown' },
  { page_url: 'https://www.cardrush.jp/product/1' }, { image_url: 'https://evil.example/image.png' },
  { file: '../image.png' }, { sha256: 'f'.repeat(64) }, { note: '' },
])('rejects invalid manifest entry %j', async patch => {
  await expect(prepareTokyoCardrushImages({ ...manifest, products: [{ ...manifest.products[0], ...patch }] }, directory, [product])).rejects.toThrow();
});

test('source SHA verification requires equal source and candidate hashes', async () => {
  await expect(prepareTokyoCardrushImages({ ...manifest, products: [{ ...manifest.products[0],
    verification_method: 'source_sha256_equal', source_image_sha256: 'a'.repeat(64),
  }] }, directory, [product])).rejects.toThrow('source image hash');
});

test('null-model Cardrush PSA rejects manual visual evidence without an exact source hash', async () => {
  await expect(prepareTokyoCardrushImages({ ...manifest, products: [{ ...manifest.products[0],
    verification_method: 'manual_visual', source_sha256_equal: false,
  }] }, directory, [product])).rejects.toThrow('null-model PSA source image hash');
});

test('rejects other store and duplicate entries', async () => {
  await expect(prepareTokyoCardrushImages({ ...manifest, store: 'manman' }, directory, [product])).rejects.toThrow('scope');
  await expect(prepareTokyoCardrushImages({ ...manifest, products: [...manifest.products, ...manifest.products] }, directory, [product])).rejects.toThrow('duplicate');
});
