// Explicitly reviewed manifest only. Default is local validation; --apply writes Storage + mapping.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { TokyoCardImageMappingRow } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { uploadToStorage } from '../lib/asset-storage.js';

export async function prepareTcgmpImageImport(manifestPath: string) {
  const document = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (document?.kind === 'tcgmp_image_review_v1' && document.haraka_reviewed?.length) {
    throw new Error('Haraka DB selections require separate review; refusing a partial TCGMP-only import');
  }
  const input: unknown = document?.kind === 'tcgmp_image_review_v1' ? document.reviewed : document;
  if (!Array.isArray(input) || !input.length) throw new Error('Expected reviewed mapping array');
  const seen = new Set<string>();
  const prepared: { row: TokyoCardImageMappingRow; bytes: Buffer; path: string; contentType: string }[] = [];
  for (const item of input) {
    if (!item || typeof item.source_shinsoku_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.source_shinsoku_id)
      || (item.product_type !== undefined && item.product_type !== 'psa')
      || seen.has(item.source_shinsoku_id) || !['Pokemon','ONE PIECE','YU-GI-OH!','WEISS SCHWARZ','DRAGON BALL'].includes(item.franchise)
      || typeof item.name !== 'string' || !item.name.trim() || typeof item.model_number !== 'string' || !item.model_number.trim()
      || typeof item.tcgmp_product_id !== 'string' || !/^\d+$/.test(item.tcgmp_product_id)
      || typeof item.tcgmp_sku !== 'string' || !item.tcgmp_sku.trim()
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !['jpg', 'png'].some(ext => item.file === `${item.sha256}.${ext}`)
      || item.evidence?.no_sample !== true || item.evidence?.no_slab !== true || item.evidence?.variant_confirmed !== true
      || typeof item.evidence.note !== 'string' || !item.evidence.note.trim()
      || typeof item.verified_at !== 'string' || !Number.isFinite(Date.parse(item.verified_at))) {
      throw new Error('Unverified, invalid or duplicate image mapping');
    }
    seen.add(item.source_shinsoku_id);
    const bytes = await readFile(resolve(dirname(manifestPath), item.file));
    if (bytes.length > 12 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Image checksum/size mismatch');
    const meta = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
    const extension = meta.format === 'jpeg' ? 'jpg' : meta.format === 'png' ? 'png' : null;
    if (!extension || item.file !== `${item.sha256}.${extension}` || (meta.pages ?? 1) !== 1
      || !meta.width || !meta.height || meta.width < 200 || meta.height < 200) throw new Error('Invalid image dimensions/format');
    const path = `card-images/manman-akihabara/tcgmp/${item.file}`;
    const row: TokyoCardImageMappingRow = {
      provider: 'tcgmp', provider_product_id: item.tcgmp_product_id,
      source_shinsoku_id: item.source_shinsoku_id, franchise: item.franchise, product_type: item.product_type, name: item.name,
      model_number: item.model_number, tcgmp_product_id: item.tcgmp_product_id, tcgmp_sku: item.tcgmp_sku,
      sha256: item.sha256, verified_at: item.verified_at, evidence: item.evidence,
      image_url: `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/${path}`,
    };
    prepared.push({ row, bytes, path, contentType: extension === 'jpg' ? 'image/jpeg' : 'image/png' });
  }
  return prepared;
}

async function main() {
  const [manifest, flag, ...extra] = process.argv.slice(2);
  if (!manifest || (flag !== undefined && flag !== '--apply') || extra.length) throw new Error('Usage: import-tcgmp-images.ts reviewed.json [--apply]');
  const prepared = await prepareTcgmpImageImport(resolve(manifest));
  if (flag === '--apply') {
    if (process.env.SUPABASE_URL !== 'https://abyecthqjjssegwazhwm.supabase.co'
      || process.env.STORE_NAME !== 'manman-akihabara') throw new Error('Tokyo target configuration required');
    const db = createSupabaseClient();
    for (const item of prepared) await uploadToStorage(db, item.path, item.bytes, item.contentType);
    const { error } = await db.from('tokyo_card_image_mapping').upsert(prepared.map(item => item.row));
    if (error) throw new Error(`Mapping import failed: ${error.message}`);
    const { data, error: readError } = await db.from('tokyo_card_image_mapping').select('*')
      .in('source_shinsoku_id', prepared.map(item => item.row.source_shinsoku_id));
    if (readError || !data || data.length !== prepared.length || prepared.some(item => !data.some(row =>
      row.source_shinsoku_id === item.row.source_shinsoku_id && row.image_url === item.row.image_url
      && row.name === item.row.name && row.model_number === item.row.model_number && row.sha256 === item.row.sha256
      && row.franchise === item.row.franchise && row.tcgmp_product_id === item.row.tcgmp_product_id
      && row.provider === 'tcgmp' && row.provider_product_id === item.row.provider_product_id
      && row.tcgmp_sku === item.row.tcgmp_sku && Date.parse(row.verified_at) === Date.parse(item.row.verified_at)
      && row.evidence.no_sample === true && row.evidence.no_slab === true && row.evidence.variant_confirmed === true
      && row.evidence.note === item.row.evidence.note))) {
      throw new Error('Mapping readback failed; inspect existing state before retry');
    }
  }
  console.log(JSON.stringify({ applied: flag === '--apply', mappings: prepared.map(item => item.row) }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Image import failed');
  process.exitCode = 1;
});
