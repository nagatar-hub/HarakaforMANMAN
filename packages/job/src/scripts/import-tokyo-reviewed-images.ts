/** Local validation by default. Production application requires a frozen manifest hash. */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import type { TokyoCardImageMappingRow, DbCardRow, Database } from '@haraka/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { harakaImageUrl } from '../lib/haraka-card-images.js';
import { createSupabaseClient } from '../lib/supabase.js';
import { downloadFromStorage } from '../lib/asset-storage.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const requireValid = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
type Expected = { product: any; decision: any; candidate: any; provider: TokyoCardImageMappingRow['provider']; datasetId: string };
type ExistingMappingSnapshot = { count: number; sha256: string };

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function mappingSetSnapshot(rows: TokyoCardImageMappingRow[]): ExistingMappingSnapshot {
  const sorted = [...rows].sort((a, b) => a.source_shinsoku_id.localeCompare(b.source_shinsoku_id));
  return { count: sorted.length, sha256: hash(JSON.stringify(stable(sorted))) };
}

export async function verifyExistingMappingSet(db: SupabaseClient<Database>, ids: string[], expected: ExistingMappingSnapshot) {
  const rows: TokyoCardImageMappingRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await db.from('tokyo_card_image_mapping').select('*').in('source_shinsoku_id', ids.slice(offset, offset + 100));
    if (error) throw new Error(`Existing mapping read failed: ${error.message}`);
    rows.push(...(data ?? []));
  }
  requireValid(isDeepStrictEqual(mappingSetSnapshot(rows), expected), 'Existing mapping set changed; rebuild and review manifest');
}

/** Bind both user exports to the exact candidate datasets and derive every accepted identity. */
export function validateTokyoReviewManifest(document: any): Map<string, Expected> {
  const { baseline, additional, source_dataset: source, additional_dataset: extra } = document ?? {};
  requireValid(document?.kind === 'tokyo_reviewed_image_manifest_v1' && Array.isArray(document.mappings), 'Invalid manifest kind');
  requireValid(baseline?.kind === 'tcgmp_image_review_v1' && additional?.kind === 'additional_image_review_v1'
    && Array.isArray(source?.items) && Array.isArray(extra?.items), 'Missing review datasets');
  const sourceHash = hash(JSON.stringify(source.items.map((item: any) => ({
    id: item.id, franchise: item.franchise, name: item.name, model_number: item.model_number, product_type: item.product_type,
    sourceImage: item.sourceImage, harakaMatch: item.harakaMatch,
    candidates: item.candidates.map((c: any) => ({ id: c.id, sku: c.sku, sha256: c.sha256, ...(c.provider === 'haraka' ? { image: c.image } : {}) })),
  }))));
  requireValid(sourceHash === source.datasetId && baseline.dataset_id === source.datasetId, 'Source dataset mismatch');
  requireValid(extra.datasetId === hash(JSON.stringify({ items: extra.items, baseline: extra.baseline }))
    && additional.dataset_id === extra.datasetId && isDeepStrictEqual(baseline, extra.baseline)
    && isDeepStrictEqual(baseline, additional.baseline) && isDeepStrictEqual(additional.candidates, extra.items), 'Additional dataset/baseline mismatch');
  const products = new Map<string, any>(source.items.map((p: any) => [p.id, p]));
  requireValid(products.size === source.items.length && new Set(extra.items.map((p: any) => p.id)).size === extra.items.length, 'Duplicate dataset products');
  for (const item of source.items) requireValid(new Set(item.candidates.map((c: any) => c.id)).size === item.candidates.length, 'Duplicate source candidates');
  for (const item of extra.items) requireValid(new Set(item.candidates.map((c: any) => c.key)).size === item.candidates.length, 'Duplicate additional candidates');
  const expected = new Map<string, Expected>();
  for (const [review, dataset, isAdditional] of [[baseline, source, false], [additional, extra, true]] as const) {
    requireValid(review.decisions && typeof review.decisions === 'object' && !Array.isArray(review.decisions), 'Invalid decisions');
    for (const [id, d] of Object.entries(review.decisions) as [string, any][]) {
      const item = dataset.items.find((p: any) => p.id === id), product = products.get(id);
      requireValid(item && product && ['adopt', 'hold', 'none'].includes(d?.status)
        && typeof d.note === 'string' && d.note.length <= 2000 && typeof d.at === 'string' && Number.isFinite(Date.parse(d.at)), 'Unknown/invalid review decision');
      if (isAdditional) requireValid(['hold', 'none'].includes(baseline.decisions[id]?.status), 'Additional review overwrites prior adoption');
      if (d.status !== 'adopt') continue;
      requireValid(d.no_sample === true && d.no_slab === true && d.variant_confirmed === true, 'Missing user confirmation');
      const candidate = item.candidates.find((c: any) => isAdditional ? c.key === d.candidateKey : c.id === d.candidateId);
      const provider = isAdditional ? candidate?.key.split(':')[0] : candidate?.provider === 'haraka' ? 'haraka' : 'tcgmp';
      requireValid(candidate && ['haraka', 'onphalos', 'tcgmp'].includes(provider) && ['psa', 'box'].includes(product.product_type)
        && (product.product_type !== 'box' || provider === 'haraka')
        && (provider !== 'onphalos' || (product.franchise === 'Pokemon' && product.product_type === 'psa'))
        && !expected.has(id), 'Foreign candidate/unsupported product');
      requireValid(isAdditional ? candidate.key === `${provider}:${candidate.id}` : ['haraka', 'tcgmp'].includes(candidate.provider), 'Invalid candidate provider');
      if (!isAdditional) requireValid(provider === 'haraka' ? d.provider === 'haraka' && d.sha256 === undefined : d.provider !== 'haraka' && d.sha256 === candidate.sha256, 'Candidate identity mismatch');
      requireValid(provider === 'haraka' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id) : /^\d{1,200}$/.test(candidate.id), 'Invalid provider identity');
      expected.set(id, { product, decision: d, candidate, provider, datasetId: dataset.datasetId });
    }
  }
  requireValid(expected.size > 0 && expected.size === document.mappings.length, 'Partial or empty approved-image manifest');
  const seen = new Set<string>();
  for (const row of document.mappings) {
    const e = expected.get(row.source_shinsoku_id);
    requireValid(e && !seen.has(row.source_shinsoku_id), 'Unknown/duplicate mapping');
    seen.add(row.source_shinsoku_id);
    const { product, candidate, provider, decision } = e!;
    const pixelExactOnphalos = provider === 'onphalos' && product.product_type === 'psa'
      && product.franchise === 'Pokemon' && product.model_number === null
      && decision.pixel_exact === true && decision.source_image_sha256 === row.sha256
      && row.evidence?.pixel_exact === true && row.evidence?.source_image_sha256 === row.sha256;
    const validModel = product.product_type === 'box' ? row.model_number === null
      : (typeof row.model_number === 'string' && !!row.model_number.trim()) || pixelExactOnphalos;
    requireValid(row.provider === provider && row.provider_product_id === candidate.id
      && row.franchise === product.franchise && row.product_type === product.product_type
      && row.name === product.name && row.model_number === product.model_number
      && validModel
      && row.source_url === candidate.image
      && row.verified_at === decision.at, 'Mapping identity/URL mismatch');
    requireValid(row.evidence?.no_sample === true && row.evidence?.no_slab === true && row.evidence?.variant_confirmed === true
      && typeof row.evidence.note === 'string' && row.evidence.note.trim(), 'Missing mapping evidence');
    if (provider === 'tcgmp') requireValid(row.sha256 === candidate.sha256 && row.tcgmp_product_id === candidate.id && row.tcgmp_sku === candidate.sku, 'TCGMP identity/hash mismatch');
    else {
      requireValid(row.tcgmp_product_id == null && row.tcgmp_sku == null, 'Provider mislabeled as TCGMP');
      if (provider === 'onphalos') {
        const url = new URL(row.source_url);
        requireValid(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
          && url.hostname === 'www.pokemon-card.com'
          && /^\/assets\/images\/card_images\/.*\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname), 'Official image URL required');
      } else requireValid(harakaImageUrl({ image_url: row.source_url, alt_image_url: null, image_status: 'unchecked' } as DbCardRow), 'Unsafe source image URL');
    }
  }
  return expected;
}

export async function prepareTokyoReviewedImageImport(manifestPath: string) {
  const raw = await readFile(manifestPath);
  const document = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  const expected = validateTokyoReviewManifest(document);
  const prepared: { row: TokyoCardImageMappingRow; bytes: Buffer; path: string; contentType: string }[] = [];
  for (const item of document.mappings) {
    requireValid(/^[a-f0-9]{64}$/.test(item.sha256) && ['jpg', 'png', 'webp'].some(ext => item.file === `${item.sha256}.${ext}`), 'Invalid image file/hash');
    const bytes = await readFile(resolve(dirname(manifestPath), item.file));
    requireValid(bytes.length <= 12 * 1024 * 1024 && hash(bytes) === item.sha256, 'Image checksum/size mismatch');
    const metadata = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    requireValid(['jpg', 'png', 'webp'].includes(extension ?? '') && item.file === `${item.sha256}.${extension}`
      && (metadata.pages ?? 1) === 1 && metadata.width && metadata.width >= 200 && metadata.height && metadata.height >= 200, 'Invalid image format/dimensions');
    const e = expected.get(item.source_shinsoku_id)!;
    const path = `card-images/manman-akihabara/${e.provider}/${item.file}`;
    prepared.push({ bytes, path, contentType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`, row: {
      source_shinsoku_id: item.source_shinsoku_id, franchise: item.franchise, product_type: item.product_type,
      name: item.name, model_number: item.model_number,
      provider: e.provider, provider_product_id: e.candidate.id,
      tcgmp_product_id: e.provider === 'tcgmp' ? e.candidate.id : null, tcgmp_sku: e.provider === 'tcgmp' ? e.candidate.sku : null,
      sha256: item.sha256, verified_at: item.verified_at,
      evidence: { ...item.evidence, dataset_id: e.datasetId, source_url: item.source_url, user_note: e.decision.note },
      image_url: `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/${path}`,
    } });
  }
  const snapshot = document.audit?.existing_mappings;
  if (snapshot !== undefined) requireValid(Number.isInteger(snapshot?.count) && snapshot.count >= 0
    && typeof snapshot.sha256 === 'string' && /^[a-f0-9]{64}$/.test(snapshot.sha256), 'Invalid existing mapping snapshot');
  return { manifestSha256: hash(raw), prepared, existingMappingSnapshot: snapshot as ExistingMappingSnapshot | undefined };
}

async function main() {
  const [manifest, flag, confirmationFlag, confirmation, ...extra] = process.argv.slice(2);
  if (!manifest || extra.length || (flag !== undefined && (flag !== '--apply' || confirmationFlag !== '--confirm-sha256' || !confirmation))) throw new Error('Usage: import-tokyo-reviewed-images.js manifest.json [--apply --confirm-sha256 HASH]');
  const result = await prepareTokyoReviewedImageImport(resolve(manifest));
  if (flag === '--apply') {
    requireValid(confirmation === result.manifestSha256 && process.env.STORE_NAME === 'manman-akihabara'
      && process.env.SUPABASE_URL === 'https://abyecthqjjssegwazhwm.supabase.co', 'Frozen hash and Tokyo target required');
    const db = createSupabaseClient();
    const ids = result.prepared.map(item => item.row.source_shinsoku_id);
    if (result.existingMappingSnapshot) await verifyExistingMappingSet(db, ids, result.existingMappingSnapshot);
    for (const item of result.prepared) {
      const { error } = await db.storage.from('haraka-images').upload(item.path, item.bytes, { contentType: item.contentType, upsert: false });
      // Even an existing path must contain exactly the approved bytes before DB publication.
      if (error && !/already exists|duplicate/i.test(error.message)) throw new Error('Image upload failed; inspect state before retry');
      requireValid(hash(await downloadFromStorage(db, item.path)) === item.row.sha256, 'Storage readback checksum mismatch');
    }
    if (result.existingMappingSnapshot) await verifyExistingMappingSet(db, ids, result.existingMappingSnapshot);
    const { error } = await db.from('tokyo_card_image_mapping').upsert(result.prepared.map(item => item.row));
    if (error) throw new Error(`Mapping import failed: ${error.message}`);
    const { data, error: readError } = await db.from('tokyo_card_image_mapping').select('*').in('source_shinsoku_id', result.prepared.map(item => item.row.source_shinsoku_id));
    requireValid(!readError && data?.length === result.prepared.length && result.prepared.every(item => data?.some(row =>
      Object.entries(item.row).every(([key, value]) => key === 'verified_at' ? Date.parse(row.verified_at) === Date.parse(String(value)) : isDeepStrictEqual((row as any)[key], value)))), 'Mapping readback failed; inspect state before retry');
  }
  console.log(JSON.stringify({ applied: flag === '--apply', manifestSha256: result.manifestSha256, mappings: result.prepared.length }));
}
if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : 'Import failed'); process.exitCode = 1; });
