/** Unmodified, manually reviewed images. Dry run first; writes require the frozen manifest hash. */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import type { TokyoCardImageMappingRow } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { downloadFromStorage } from '../lib/asset-storage.js';
import { hasAssistantImageEvidence } from '../lib/tokyo-reviewed-image-evidence.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function check(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
export function sameMapping(a: any, b: any): boolean {
  if (!a || !b) return a === b;
  return isDeepStrictEqual({ ...a, verified_at: Date.parse(a.verified_at) }, { ...b, verified_at: Date.parse(b.verified_at) });
}

export async function prepareAssistantImages(raw: Buffer, directory: string) {
  const doc = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  check(doc.kind === 'tokyo_assistant_image_review_v1' && doc.store === 'manman-akihabara', 'Invalid manifest scope');
  check(typeof doc.snapshot_id === 'string' && /^[0-9a-f-]{36}$/.test(doc.snapshot_id), 'Missing source snapshot');
  check(Number.isFinite(Date.parse(doc.verified_at)) && Array.isArray(doc.products) && doc.products.length > 0, 'Missing review');
  const manifestSha256 = hash(raw), assetDirectory = await realpath(resolve(directory, 'accepted'));
  const seen = new Set<string>();
  const prepared = [];
  for (const p of doc.products) {
    check(typeof p.id === 'string' && p.id.trim().length > 0 && p.id.length <= 200 && !seen.has(p.id), 'Duplicate/missing source ID');
    seen.add(p.id);
    check(['Pokemon', 'ONE PIECE', 'WEISS SCHWARZ', 'YU-GI-OH!', 'DRAGON BALL'].includes(p.franchise)
      && typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 300
      && (p.product_type === 'box' ? p.model_number === null : p.product_type === 'psa'
        && typeof p.model_number === 'string' && p.model_number.trim().length > 0 && p.model_number.length <= 200), 'Invalid product identity');
    check(typeof p.sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sha256), 'Invalid asset hash');
    const ext = ['jpg', 'png', 'webp'].find(e => p.file === `accepted/${p.sha256}.${e}`);
    check(ext, 'Invalid asset path');
    const file = await realpath(resolve(directory, p.file));
    check(dirname(file) === assetDirectory, 'Asset escapes accepted directory');
    const bytes = await readFile(file);
    check(bytes.length <= 12 * 1024 * 1024 && hash(bytes) === p.sha256, 'Asset hash/size mismatch');
    const meta = await sharp(bytes, { limitInputPixels: 25000000 }).metadata();
    check(meta.format === (ext === 'jpg' ? 'jpeg' : ext), 'Asset format mismatch');
    await sharp(bytes, { limitInputPixels: 25000000 }).raw().toBuffer();
    const path = `card-images/manman-akihabara/reviewed/${p.sha256}.${ext}`;
    const row: TokyoCardImageMappingRow = {
      source_shinsoku_id: p.id, franchise: p.franchise, product_type: p.product_type, name: p.name, model_number: p.model_number,
      provider: 'reviewed', provider_product_id: p.id, tcgmp_product_id: null, tcgmp_sku: null,
      image_url: `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/${path}`,
      sha256: p.sha256, verified_at: doc.verified_at,
      evidence: { ...p.evidence, review_manifest_sha256: manifestSha256 },
    };
    check(hasAssistantImageEvidence(row) && row.evidence.no_sample === true && row.evidence.no_slab === true
      && row.evidence.variant_confirmed === true && typeof row.evidence.note === 'string'
      && row.evidence.note.trim().length > 0, 'Missing manual visual evidence');
    check(p.expected_mapping === null || p.expected_mapping?.source_shinsoku_id === p.id, 'Missing expected mapping before-image');
    prepared.push({ row, bytes, path, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, expected: p.expected_mapping });
  }
  return { prepared, manifestSha256, snapshotId: doc.snapshot_id };
}

async function main() {
  const [file, flag, confirmFlag, confirmation, ...extra] = process.argv.slice(2);
  check(file && !extra.length && (flag === undefined || flag === '--apply' && confirmFlag === '--confirm-sha256' && confirmation),
    'Usage: import-tokyo-assistant-images.js manifest.json [--apply --confirm-sha256 HASH]');
  const { prepared, manifestSha256, snapshotId } = await prepareAssistantImages(await readFile(file), dirname(resolve(file)));
  if (flag === '--apply') {
    check(confirmation === manifestSha256 && process.env.STORE_NAME === 'manman-akihabara'
      && process.env.SUPABASE_URL === 'https://abyecthqjjssegwazhwm.supabase.co', 'Frozen hash and Tokyo target required');
    const db = createSupabaseClient();
    const { data: snapshot, error: snapshotError } = await db.from('tokyo_buyback_snapshot').select('store').eq('id', snapshotId).single();
    check(!snapshotError && snapshot?.store === 'manman-akihabara', 'Wrong source snapshot');
    for (const item of prepared) {
      const { data: product, error: productError } = await db.from('tokyo_buyback_product').select('id,franchise,product_type,name,model_number')
        .eq('snapshot_id', snapshotId).eq('id', item.row.source_shinsoku_id).single();
      check(!productError && product && product.name === item.row.name && product.franchise === item.row.franchise
        && product.model_number === item.row.model_number && product.product_type === item.row.product_type, 'Source identity drift');
      const { data: old, error: oldError } = await db.from('tokyo_card_image_mapping').select('*').eq('source_shinsoku_id', item.row.source_shinsoku_id).maybeSingle();
      check(!oldError && (sameMapping(old, item.expected) || sameMapping(old, item.row)), 'Mapping changed since review');
    }
    for (const item of prepared) {
      const { error } = await db.storage.from('haraka-images').upload(item.path, item.bytes, { contentType: item.contentType, upsert: false });
      check(!error || /already exists|duplicate/i.test(error.message), 'Image upload failed');
      check(hash(await downloadFromStorage(db, item.path)) === item.row.sha256, 'Storage readback mismatch');
    }
    // Insert absent rows; updates use compare-and-swap of the complete expected before-image.
    for (const item of prepared) {
      const { data: old, error: readError } = await db.from('tokyo_card_image_mapping').select('*').eq('source_shinsoku_id', item.row.source_shinsoku_id).maybeSingle();
      check(!readError, 'Mapping read failed');
      if (sameMapping(old, item.row)) continue;
      check(sameMapping(old, item.expected), 'Mapping changed during upload');
      let write;
      if (item.expected === null) write = await db.from('tokyo_card_image_mapping').insert(item.row).select('*').single();
      else {
        let query = db.from('tokyo_card_image_mapping').update(item.row).eq('source_shinsoku_id', item.row.source_shinsoku_id);
        for (const [key, value] of Object.entries(item.expected)) {
          check(value !== undefined, 'Invalid expected mapping field');
          query = value === null ? query.is(key, null) : query.eq(key, typeof value === 'object' ? JSON.stringify(value) : value);
        }
        write = await query.select('*').single();
      }
      check(!write.error && sameMapping(write.data, item.row), 'Mapping CAS/readback failed; inspect before retry');
    }
  }
  console.log(JSON.stringify({ applied: flag === '--apply', manifestSha256, mappings: prepared.length }));
}
if (require.main === module) main().catch(e => { console.error(e instanceof Error ? e.message : 'Import failed'); process.exitCode = 1; });
