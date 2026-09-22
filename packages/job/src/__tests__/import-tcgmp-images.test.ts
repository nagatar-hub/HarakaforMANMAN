import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareTcgmpImageImport } from '../scripts/import-tcgmp-images';

test('reviewed file -> hash-checked Tokyo mapping; no approval, path escape and changed bytes rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tcgmp-import-test-'));
  try {
    const bytes = await sharp({ create: { width: 200, height: 280, channels: 3, background: '#fff' } }).png().toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${sha256}.png`;
    const manifest = join(directory, 'reviewed.json');
    const row = { source_shinsoku_id: 'psa-1', franchise: 'Pokemon', name: 'テスト', model_number: '001/001',
      tcgmp_product_id: '123', tcgmp_sku: '001-001', sha256, file, verified_at: '2026-09-07T00:00:00Z',
      evidence: { no_sample: true, no_slab: true, variant_confirmed: true, note: 'Synthetic input validation test, not real image approval' } };
    await writeFile(join(directory, file), bytes);
    await writeFile(manifest, JSON.stringify([row]));
    const result = await prepareTcgmpImageImport(manifest);
    expect(result[0].row.image_url).toBe(`https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/tcgmp/${file}`);
    await writeFile(manifest, JSON.stringify({ kind: 'tcgmp_image_review_v1', reviewed: [row], haraka_reviewed: [{ db_card_id: 'manual-choice' }] }));
    await expect(prepareTcgmpImageImport(manifest)).rejects.toThrow('refusing a partial');
    for (const invalid of [{ ...row, evidence: { ...row.evidence, variant_confirmed: false } },
      { ...row, file: '../secret' }, { ...row, tcgmp_product_id: 'abc' }, { ...row, product_type: 'box' }]) {
      await writeFile(manifest, JSON.stringify([invalid]));
      await expect(prepareTcgmpImageImport(manifest)).rejects.toThrow();
    }
    await writeFile(manifest, JSON.stringify([row]));
    await writeFile(join(directory, file), 'changed');
    await expect(prepareTcgmpImageImport(manifest)).rejects.toThrow('checksum');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
