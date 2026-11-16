import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareAssistantImages, sameMapping } from '../scripts/import-tokyo-assistant-images';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

let directory: string, manifest: any;
const product = { id: 'IAP123', franchise: 'Pokemon', name: 'アズサ(1ED)', model_number: '064/059', product_type: 'psa' };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tokyo-assistant-images-'));
  await mkdir(join(directory, 'accepted'));
  const bytes = await sharp({ create: { width: 10, height: 15, channels: 3, background: 'white' } }).png().toBuffer();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'accepted', sha256 + '.png'), bytes);
  manifest = { kind: 'tokyo_assistant_image_review_v1', store: 'manman-akihabara',
    snapshot_id: '32562db0-44a7-4448-9e97-0b7a96982a12', verified_at: '2026-11-17T00:00:00Z', products: [{
      ...product, sha256, file: `accepted/${sha256}.png`, expected_mapping: null,
      evidence: { verified_by: 'assistant', user_approved: false, no_sample: true, no_slab: true, variant_confirmed: true,
        visual_identity_verified: true, verification_method: 'manual_visual', reviewed_asset_sha256: sha256,
        source_url: 'https://www.pokemon-card.com/assets/images/card_images/large/XY/a.png',
        identity_note: 'Test fixture, not a real visual review', note: 'Test fixture only' },
    }] };
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const prepare = (doc: any) => prepareAssistantImages(Buffer.from(JSON.stringify(doc)), directory);
const snapshot = (p: any = product) => ({ snapshot: { store: 'manman-akihabara', business_date: '2026-11-17' },
  products: [{ ...p, price_high: 9500, price_low: 9000 }] } as any);

test('frozen review reaches normal generation without importing another tenant DB identity or changing prices', async () => {
  const { prepared, manifestSha256 } = await prepare(manifest);
  const row = prepared[0].row;
  expect(row.evidence.review_manifest_sha256).toBe(manifestSha256);
  expect(buildTokyoPreparedCards('run', snapshot(), [row])[0]).toMatchObject({ image_url: row.image_url,
    db_card_id: null, grade: 'PSA10', price_high: 9500, price_low: 9000 });
  for (const p of [{ ...product, name: 'アズサ' }, { ...product, model_number: '064/060' },
    { ...product, id: 'other' }, { ...product, franchise: 'ONE PIECE' }]) {
    expect(buildTokyoPreparedCards('run', snapshot(p), [row])[0].image_url).toBeNull();
  }
  for (const evidence of [{ user_approved: true }, { no_slab: false }, { reviewed_asset_sha256: 'f'.repeat(64) },
    { review_manifest_sha256: '' }, { source_url: 'https://www.pokemon-card.com.evil.test/a.png' }]) {
    expect(buildTokyoPreparedCards('run', snapshot(), [{ ...row, evidence: { ...row.evidence, ...evidence } }])[0].image_url).toBeNull();
  }
});

test('rejects unreviewed, misplaced, mismatched and duplicate assets before any production access', async () => {
  const base = manifest.products[0];
  for (const patch of [{ file: '../escape.png' }, { sha256: 'f'.repeat(64) }, { expected_mapping: undefined },
    { model_number: null }, { evidence: { ...base.evidence, visual_identity_verified: false } },
    { evidence: { ...base.evidence, source_url: 'https://storage.googleapis.com/shinsoku-tcg-public/slab.png' } }]) {
    await expect(prepare({ ...manifest, products: [{ ...base, ...patch }] })).rejects.toThrow();
  }
  await expect(prepare({ ...manifest, products: [base, base] })).rejects.toThrow('Duplicate');
  await expect(prepare({ ...manifest, store: 'oripark' })).rejects.toThrow('scope');
});

test('BOX image is accepted only for its reviewed identity and remains a BOX', async () => {
  const p = { ...product, name: '夢限大みゅーたいぷ', franchise: 'WEISS SCHWARZ', product_type: 'box', model_number: null };
  const { prepared } = await prepare({ ...manifest, products: [{ ...manifest.products[0], ...p }] });
  expect(buildTokyoPreparedCards('run', snapshot(p), [prepared[0].row])[0]).toMatchObject({ tag: 'BOX', grade: '未開封BOX', image_url: prepared[0].row.image_url });
});

test('expected mapping comparisons preserve every field and normalize only timestamp formatting', () => {
  const a = { name: 'same', verified_at: '2026-11-17T00:00:00Z', evidence: { no_slab: true } };
  expect(sameMapping(a, { ...a, verified_at: '2026-11-17 00:00:00+00' })).toBe(true);
  expect(sameMapping(a, { ...a, name: 'other' })).toBe(false);
  expect(sameMapping(null, a)).toBe(false);
});
