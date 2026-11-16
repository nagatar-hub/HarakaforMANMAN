import type { TokyoCardImageMappingRow } from '@haraka/shared';

/** Reviewed is an internal, per-source-product archive, not an external image vendor. */
export function hasAssistantImageEvidence(row: TokyoCardImageMappingRow): boolean {
  const e = row.evidence;
  return row.provider === 'reviewed' && row.provider_product_id === row.source_shinsoku_id
    && e.verified_by === 'assistant' && e.user_approved === false
    && e.visual_identity_verified === true && e.verification_method === 'manual_visual'
    && e.reviewed_asset_sha256 === row.sha256
    && typeof e.review_manifest_sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.review_manifest_sha256)
    && typeof e.source_url === 'string' && isReviewedImageSource(e.source_url)
    && typeof e.identity_note === 'string' && e.identity_note.trim().length > 0;
}

export function isReviewedImageSource(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    const paths: Record<string, RegExp> = {
      'www.pokemon-card.com': /^\/assets\/images\/card_images\/large\//,
      'cdn.snkrdunk.com': /^\/upload_bg_removed\//,
      'd1sqsdq2kxn50g.cloudfront.net': /^\/(?:TS|TL|TXL)\/[A-Za-z0-9/_-]+\.(?:jpg|jpeg|png)$/i,
      'ws-tcg.com': /^\/wordpress\/wp-content\/(?:uploads|images\/cardlist)\//,
      'www.cardrush-pokemon.jp': /^\/data\/cardrushpokemon\/(?:product|_)\//,
      'www.cardrush-op.jp': /^\/data\/cardrush-op\/product\//,
      'abyecthqjjssegwazhwm.supabase.co': /^\/storage\/v1\/object\/public\/haraka-images\/card-images\/manman-akihabara\/(?:tcgmp|haraka|onphalos|cardrush)\//,
      'fexadnveyuqduiujewrc.supabase.co': /^\/storage\/v1\/object\/public\/(?:cards|goods)\//,
      'firebasestorage.googleapis.com': /^\/v0\/b\/pokeca-api\.appspot\.com\/o\//,
    };
    return !!paths[url.hostname]?.test(url.pathname) && /\.(?:png|jpe?g|webp)$/i.test(url.pathname);
  } catch { return false; }
}
