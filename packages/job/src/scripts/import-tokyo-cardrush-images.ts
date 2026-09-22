/** Dry-run by default. Production import requires the frozen manifest hash and Tokyo target. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { downloadFromStorage } from '../lib/asset-storage.js';
import { createSupabaseClient } from '../lib/supabase.js';
import { prepareTokyoCardrushImages } from '../lib/tokyo-cardrush-images.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Existing production rows may only gain the reviewed ONE PIECE tag evidence. */
export function acceptsTagEvidenceBackfill(existing: Record<string, any>, proposed: Record<string, any>): boolean {
  if (Object.entries(proposed).every(([key, value]) => key === 'verified_at'
    ? Date.parse(existing.verified_at) === Date.parse(String(value)) : isDeepStrictEqual(existing[key], value))) return true;
  const { tag: oldTag, source_title: oldTitle, ...oldEvidence } = existing.evidence ?? {};
  const { tag: newTag, source_title: newTitle, ...newEvidence } = proposed.evidence ?? {};
  return oldTag === undefined && oldTitle === undefined && typeof newTag === 'string' && typeof newTitle === 'string'
    && isDeepStrictEqual(oldEvidence, newEvidence)
    && Object.entries(proposed).every(([key, value]) => key === 'evidence' || (key === 'verified_at'
      ? Date.parse(existing.verified_at) === Date.parse(String(value)) : isDeepStrictEqual(existing[key], value)));
}

async function main() {
  const [manifestPath, flag, confirmationFlag, confirmation, ...extra] = process.argv.slice(2);
  check(manifestPath && !extra.length && (flag === undefined || (flag === '--apply' && confirmationFlag === '--confirm-sha256' && confirmation)),
    'Usage: import-tokyo-cardrush-images.js manifest.json [--apply --confirm-sha256 HASH]');
  const absolutePath = resolve(manifestPath);
  const raw = await readFile(absolutePath);
  const document = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  check(Array.isArray(document.source_products), 'Missing source products');
  const prepared = await prepareTokyoCardrushImages(document, dirname(absolutePath), document.source_products);
  const manifestSha256 = hash(raw);
  if (flag === '--apply') {
    check(confirmation === manifestSha256 && process.env.STORE_NAME === 'manman-akihabara'
      && process.env.SUPABASE_URL === 'https://abyecthqjjssegwazhwm.supabase.co', 'Frozen hash and Tokyo target required');
    const db = createSupabaseClient();
    const ids = prepared.map(item => item.row.source_shinsoku_id);
    const { data: existing, error: existingError } = await db.from('tokyo_card_image_mapping').select('*').in('source_shinsoku_id', ids);
    check(!existingError && existing?.every(row => prepared.some(item => acceptsTagEvidenceBackfill(row, item.row))),
    'Existing mapping differs; refusing overwrite');
    for (const item of prepared) {
      const { error } = await db.storage.from('haraka-images').upload(item.path, item.bytes, { contentType: item.contentType, upsert: false });
      if (error && !/already exists|duplicate/i.test(error.message)) throw new Error('Image upload failed; inspect state before retry');
      check(hash(await downloadFromStorage(db, item.path)) === item.row.sha256, 'Storage readback checksum mismatch');
    }
    const { error } = await db.from('tokyo_card_image_mapping').upsert(prepared.map(item => item.row));
    if (error) throw new Error(`Mapping import failed: ${error.message}`);
    const { data, error: readError } = await db.from('tokyo_card_image_mapping').select('*').in('source_shinsoku_id', ids);
    check(!readError && data?.length === prepared.length && prepared.every(item => data.some(row =>
      Object.entries(item.row).every(([key, value]) => key === 'verified_at'
        ? Date.parse(row.verified_at) === Date.parse(String(value)) : isDeepStrictEqual((row as any)[key], value)))),
    'Mapping readback failed; inspect state before retry');
  }
  console.log(JSON.stringify({ applied: flag === '--apply', manifestSha256, mappings: prepared.length }));
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : 'Import failed'); process.exitCode = 1; });
