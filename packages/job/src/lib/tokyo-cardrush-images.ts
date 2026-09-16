import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { TokyoCardImageMappingRow } from '@haraka/shared';

type Product = { id: string; franchise: string; name: string; model_number: string | null; product_type: string };
const CARDRUSH_SITE = {
  'YU-GI-OH!': { origin: 'https://www.cardrush.jp', imageDirectory: 'cardrush' },
  'ONE PIECE': { origin: 'https://www.cardrush-op.jp', imageDirectory: 'cardrush-op' },
  'Pokemon': { origin: 'https://www.cardrush-pokemon.jp', imageDirectory: 'cardrushpokemon' },
} as const;
const ONE_PIECE_TAGS = new Set(['リーパラ', 'コミパラ', 'プロモ', 'イベント', 'パラレル', 'キャラ', 'フラシ', 'ヒロイン', 'タロット']);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid Cardrush review: ${message}`);
}

/** Local preparation only: preserve assistant provenance; never upload or publish here. */
export async function prepareTokyoCardrushImages(manifest: unknown, directory: string, products: Product[]) {
  const data = manifest as any;
  check(data?.kind === 'tokyo_cardrush_image_review_v1' && data.store === 'manman-akihabara', 'manifest scope');
  check(typeof data.verified_at === 'string' && Number.isFinite(Date.parse(data.verified_at)), 'verification date');
  check(Array.isArray(data.products) && data.products.length > 0, 'products');
  const sources = new Map(products.map(product => [product.id, product]));
  check(sources.size === products.length, 'duplicate source');
  const seen = new Set<string>();
  const output: { row: TokyoCardImageMappingRow; bytes: Buffer; path: string; contentType: string }[] = [];
  const assetDirectory = await realpath(resolve(directory, 'accepted'));
  for (const entry of data.products) {
    check(entry && typeof entry.source_shinsoku_id === 'string' && !seen.has(entry.source_shinsoku_id), 'duplicate/missing identity');
    seen.add(entry.source_shinsoku_id);
    const source = sources.get(entry.source_shinsoku_id);
    const site = source && CARDRUSH_SITE[source.franchise as keyof typeof CARDRUSH_SITE];
    const box = source?.product_type === 'box';
    check(site && source.product_type === entry.product_type && (source.product_type === 'psa' || (box && source.franchise === 'ONE PIECE'))
      && (source.franchise !== 'Pokemon' || source.model_number !== null)
      && source.name === entry.name && source.model_number === entry.model_number, 'source identity');
    check(source.id.trim().length > 0 && source.id.length <= 200 && source.name.trim().length > 0 && source.name.length <= 300
      && (source.model_number === null || (source.model_number.trim().length > 0 && source.model_number.length <= 200)), 'identity lengths');
    check(entry.provider === 'cardrush' && entry.status === 'assistant_verified' && entry.verified_by === 'assistant'
      && entry.user_approved === false, 'review provenance');
    if (source.franchise === 'ONE PIECE' && !box) {
      check(typeof entry.tag === 'string' && ONE_PIECE_TAGS.has(entry.tag)
        && typeof entry.source_title === 'string' && entry.source_title.trim().length > 0
        && entry.source_title.length <= 1000, 'ONE PIECE tag evidence');
    }
    if (box) check(entry.tag === 'BOX', 'ONE PIECE BOX tag evidence');
    check(entry.no_sample === true && entry.no_slab === true && entry.variant_confirmed === true
      && entry.visual_identity_verified === true && ['source_sha256_equal', 'manual_visual'].includes(entry.verification_method)
      && typeof entry.note === 'string' && entry.note.trim().length > 0, 'visual evidence');
    check(typeof entry.cardrush_product_id === 'string' && /^\d{1,200}$/.test(entry.cardrush_product_id)
      && entry.page_url === `${site.origin}/product/${entry.cardrush_product_id}`, 'product page');
    check(typeof entry.image_url === 'string'
      && new RegExp(`^${site.origin.replaceAll('.', '\\.')}\\/(?:phone\\/)?data\\/${site.imageDirectory}\\/product\\/[A-Za-z0-9_-]+\\.(jpg|jpeg|png|webp)$`).test(entry.image_url), 'source image');
    check(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)
      && typeof entry.source_image_sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.source_image_sha256), 'image hashes');
    check(entry.verification_method !== 'source_sha256_equal' || entry.sha256 === entry.source_image_sha256, 'source image hash');
    if (!box && source.model_number === null) {
      check(entry.source_sha256_equal === true && entry.verification_method === 'source_sha256_equal'
        && entry.source_image_sha256 === entry.sha256, 'null-model PSA source image hash');
    }
    const extension = ['jpg', 'png', 'webp'].find(ext => entry.file === `accepted/${entry.sha256}.${ext}`);
    check(extension, 'asset path');
    const file = await realpath(resolve(directory, entry.file));
    check(dirname(file) === assetDirectory, 'asset outside accepted directory');
    const bytes = await readFile(file);
    check(bytes.length <= 12 * 1024 * 1024 && createHash('sha256').update(bytes).digest('hex') === entry.sha256, 'asset hash/size');
    const metadata = await sharp(bytes, { limitInputPixels: 25000000 }).metadata();
    check(metadata.format === (extension === 'jpg' ? 'jpeg' : extension), 'image format');
    await sharp(bytes, { limitInputPixels: 25000000 }).raw().toBuffer();
    const path = `card-images/manman-akihabara/cardrush/${entry.sha256}.${extension}`;
    output.push({ bytes, path, contentType: `image/${extension === 'jpg' ? 'jpeg' : extension}`, row: {
      source_shinsoku_id: source.id, franchise: source.franchise as TokyoCardImageMappingRow['franchise'],
      product_type: source.product_type as TokyoCardImageMappingRow['product_type'],
      name: source.name, model_number: source.model_number,
      provider: 'cardrush', provider_product_id: entry.cardrush_product_id, tcgmp_product_id: null, tcgmp_sku: null,
      image_url: `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/${path}`,
      sha256: entry.sha256, verified_at: data.verified_at,
      evidence: { no_sample: entry.no_sample, no_slab: entry.no_slab, variant_confirmed: entry.variant_confirmed,
        visual_identity_verified: entry.visual_identity_verified, verification_method: entry.verification_method, note: entry.note,
        verified_by: 'assistant', user_approved: false, page_url: entry.page_url, source_url: entry.image_url,
        source_image_sha256: entry.source_image_sha256, quality_note: entry.quality_note ?? '',
        ...(entry.source_sha256_equal === true ? { source_sha256_equal: true } : {}),
        ...(source.franchise === 'ONE PIECE' ? box ? { tag: 'BOX' }
          : { tag: entry.tag, source_title: entry.source_title } : {}) },
    } });
  }
  return output;
}
