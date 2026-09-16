import { calculateBoxPrice, postalProductIdentity, type Franchise, type Database, type DbCardRow, type TokyoCardImageMappingRow } from '@haraka/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync.js';
import { findHarakaImage, harakaImageUrl } from './haraka-card-images.js';

type TokyoSnapshot = Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>;

// Existing Tokyo vocabulary, tied to the reviewed postal product IDs, not fuzzy names.
const YUGIOH_TAGS: Record<string, string> = {
  IAX2400002810: 'モンスター', IAX2600000411: 'ブラックマジシャン/ガール/プロモ',
  IAX2600000410: 'ブラックマジシャン/ガール/プロモ', IAX2600000792: 'ブラックマジシャン/他言語',
  IAX2500003207: '青眼/他言語', IAX2600000407: '青眼/他言語', IAX2600000788: 'モンスター',
  IAX2600000487: 'モンスター', IAX2600000409: '青眼', IAX2600000779: 'モンスター',
  IAX2600000774: 'モンスター', IAX2600000757: 'モンスター', IAX2600000797: '真紅眼',
  IAX2600000791: 'モンスター', IAX2600000408: '青眼/他言語', IAX2600000406: '青眼',
  IAX2600000793: 'ブラックマジシャン/他言語',
};

// Assistant-reviewed main-tag fallbacks; these are not user image approvals.
const ADDITIONAL_TAGS: Record<string, readonly [string, string, string, string]> = {
  IAP2300022856: ['Pokemon', 'ナギ', '088/078', 'サポート'],
  IAP2300023198: ['Pokemon', 'ブースターEX', '006/032', 'イーブイ'],
  IAP2500005877: ['Pokemon', 'メガカイリューex', '250/193', 'メガシンカex'],
  IAP2300023611: ['Pokemon', 'メガヤミラミ＆バンギラスGX(SA)', '102/094', 'TAG'],
  IAP2300023390: ['Pokemon', 'ポッチャマ', '052/049', 'CHR'],
  IAP2300023795: ['Pokemon', 'リザードン', '005/032', 'リザードン'],
  IAP2500002618: ['Pokemon', 'レックウザV', '075/067', 'V'],
  IAO2500003918: ['ONE PIECE', 'モンキー・D・ルフィ', 'P-043', 'プロモ'],
  IAP2300023819: ['Pokemon', 'リザードンex', '139/108', 'リザードン'],
  IAP2500004443: ['Pokemon', 'メガリザードンXex', '116/080', 'リザードン'],
  IAP2300023708: ['Pokemon', 'ライチュウ＆アローラライチュウGX(SA)', '057/054', 'TAG'],
  IAO2300025596: ['ONE PIECE', 'モンキー・D・ルフィ', 'P-033', 'プロモ'],
  IAP2400003183: ['Pokemon', 'ピカチュウex', '132/106', 'ピカチュウ'],
  IAP2500000336: ['Pokemon', 'リザードンex', '125/108', 'リザードン'],
  IAP2600003975: ['Pokemon', 'メガリザードンXex', '223/193', 'リザードン'],
  IAP2500002595: ['Pokemon', 'メガサーナイトex', '092/063', 'メガシンカex'],
  IAP2300023079: ['Pokemon', 'ピカチュウ＆ゼクロムGX', '100/095', 'TAG'],
  IAP2500002563: ['Pokemon', 'メガルカリオex', '092/063', 'メガシンカex'],
  IAP2600003417: ['Pokemon', 'メガジガルデex', '117/080', 'メガシンカex'],
  IAP2300023832: ['Pokemon', 'リザードンGX', '052/051', 'リザードン'],
  IAP2300023791: ['Pokemon', 'リザードン', '011/087', 'リザードン'],
  IAP2300022894: ['Pokemon', 'ニンフィアGX', '057/051', 'イーブイ'],
  IAP2500002073: ['Pokemon', 'エーフィGX', '062/060', 'イーブイ'],
  IAP2300023085: ['Pokemon', 'ピカチュウEX', '008/027', 'ピカチュウ'],
  IAP2500003843: ['Pokemon', 'ミュウツー&ミュウGX', '097/094', 'TAG'],
  IAP2300023027: ['Pokemon', 'ピカチュウ', '010/032', 'ピカチュウ'],
};
const ONE_PIECE_TAGS = new Set(['リーパラ', 'コミパラ', 'プロモ', 'イベント', 'パラレル', 'キャラ', 'フラシ', 'ヒロイン', 'タロット']);
const RESERVED_POKEMON_TAGS = new Set(['PSA10', 'TOP', 'BOX']);

export function resolveTokyoProductTag(product: TokyoSnapshot['products'][number], dbRows: DbCardRow[],
  reviewedDbCardId: string | null = null, identityCandidates = findHarakaImage(product, dbRows).identityCandidates,
  reviewedTag: unknown = null): string {
  if (product.product_type === 'box') return 'BOX';
  const selected = reviewedDbCardId ? dbRows.find(row => row.id === reviewedDbCardId
    && row.store === 'manman-akihabara' && row.franchise === product.franchise) : null;
  if (selected?.tag?.trim()) return selected.tag.trim();
  if (product.franchise === 'ONE PIECE' && typeof reviewedTag === 'string' && ONE_PIECE_TAGS.has(reviewedTag)) return reviewedTag;
  const pokemonTag = typeof reviewedTag === 'string' ? reviewedTag.trim() : '';
  if (product.franchise === 'Pokemon' && pokemonTag && pokemonTag.length <= 100
    && !RESERVED_POKEMON_TAGS.has(pokemonTag) && !/[\u0000-\u001f\u007f]/.test(pokemonTag)) return pokemonTag;
  const tags = identityCandidates.map(row => row.tag?.trim() || null);
  if (tags.length && tags[0] && tags.every(tag => tag === tags[0])) return tags[0];
  if (product.franchise === 'YU-GI-OH!' && YUGIOH_TAGS[product.id]) return YUGIOH_TAGS[product.id];
  const fallback = ADDITIONAL_TAGS[product.id];
  return fallback && product.product_type === 'psa' && product.franchise === fallback[0]
    && product.name === fallback[1] && product.model_number === fallback[2] ? fallback[3] : 'PSA10';
}

export async function loadTokyoCardImageMappings(db: SupabaseClient<Database>, result: TokyoSnapshot): Promise<TokyoCardImageMappingRow[]> {
  if (result.snapshot.store !== 'manman-akihabara') throw new Error('Tokyo snapshot required');
  const ids = [...new Set(result.products.map(product => product.id))];
  const mappings: TokyoCardImageMappingRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await db.from('tokyo_card_image_mapping').select('*').in('source_shinsoku_id', ids.slice(offset, offset + 100));
    if (error) throw new Error(`東京画像対応取得失敗: ${error.message}`);
    mappings.push(...(data ?? []));
  }
  return mappings;
}

/** Apply each configured BOX discount once to the selected source price. */
export function buildTokyoPreparedCards(runId: string, result: TokyoSnapshot, mappings: TokyoCardImageMappingRow[] = [], dbRows: DbCardRow[] = []): Database['public']['Tables']['prepared_card']['Insert'][] {
  if (result.snapshot.store !== 'manman-akihabara') throw new Error('Tokyo snapshot required');
  const images = new Map(mappings.map(mapping => [mapping.source_shinsoku_id, mapping]));
  if (images.size !== mappings.length) throw new Error('Duplicate Tokyo image mapping');
  return result.products.map(product => {
    if (!Number.isSafeInteger(product.price_high) || product.price_high <= 0
      || !['psa', 'box'].includes(product.product_type)) throw new Error('Invalid Tokyo prepared product');
    const box = product.product_type === 'box';
    const noShrinkRate = box ? result.snapshot.settings?.box_discount_rates?.[product.franchise as Franchise]?.no_shrink : undefined;
    if (box && (typeof noShrinkRate !== 'number' || !Number.isFinite(noShrinkRate) || noShrinkRate < 0 || noShrinkRate > 1)) {
      throw new Error('Invalid Tokyo BOX no-shrink rate');
    }
    const harakaImage = findHarakaImage(product, dbRows);
    const importedDbCardIds = !box && Array.isArray(product.origins)
      ? [...new Set(product.origins.flatMap(origin => origin.source === 'kecak' && 'dbCardId' in origin
        && typeof origin.dbCardId === 'string' ? [origin.dbCardId] : []))]
      : [];
    const importedDbCardId = importedDbCardIds.length === 1 ? importedDbCardIds[0] : undefined;
    const importedDbCard = importedDbCardId ? dbRows.find(row => row.id === importedDbCardId
      && row.store === 'manman-akihabara' && row.franchise === product.franchise) : undefined;
    const importedImage = importedDbCard ? harakaImageUrl(importedDbCard) : null;
    const importedPrimaryImage = importedDbCard && importedImage === importedDbCard.alt_image_url
      ? harakaImageUrl({ ...importedDbCard, alt_image_url: null }) : null;
    const importedFallbackImage = importedImage && importedPrimaryImage
      && new URL(importedImage).hostname === 'www.cardrush-pokemon.jp'
      && new URL(importedPrimaryImage).hostname === 'fexadnveyuqduiujewrc.supabase.co'
      && new URL(importedPrimaryImage).pathname.startsWith('/storage/v1/object/public/cards/')
      ? importedPrimaryImage : null;
    const directShinsokuImage = !box && ['DRAGON BALL', 'WEISS SCHWARZ'].includes(product.franchise)
      && Array.isArray(product.origins) && product.origins.some(origin => origin.source === 'shinsoku')
      ? product.image_url : null;
    const mapping = images.get(product.id);
    const pixelExactOnphalos = mapping?.provider === 'onphalos' && mapping.product_type === 'psa'
      && mapping.franchise === 'Pokemon' && mapping.model_number === null
      && mapping.evidence.pixel_exact === true && mapping.evidence.source_image_sha256 === mapping.sha256;
    const exactCardrushNullModel = mapping?.provider === 'cardrush' && !box && mapping.model_number === null
      && mapping.evidence.source_sha256_equal === true && mapping.evidence.source_image_sha256 === mapping.sha256;
    const legacyCardrushYugiohNullModel = mapping?.provider === 'cardrush' && !box
      && mapping.franchise === 'YU-GI-OH!' && mapping.model_number === null;
    const verifiedImage = mapping && mapping.franchise === product.franchise && mapping.product_type === product.product_type
      && (mapping.name === product.name || /^IA[A-Z]\d+$/.test(product.id)
      && postalProductIdentity({ franchise: mapping.franchise, name: mapping.name, modelNumber: mapping.model_number,
        productType: box ? 'BOX' : 'PSA10' }) === postalProductIdentity({ franchise: product.franchise, name: product.name,
        modelNumber: product.model_number, productType: box ? 'BOX' : 'PSA10' }))
      && mapping.model_number === product.model_number && mapping.evidence.no_sample === true
      && mapping.evidence.no_slab === true && mapping.evidence.variant_confirmed === true
      && typeof mapping.evidence.note === 'string' && mapping.evidence.note.trim().length > 0
      && /^[0-9a-f]{64}$/.test(mapping.sha256)
      && ['tcgmp', 'haraka', 'onphalos', 'cardrush'].includes(mapping.provider)
      && (mapping.model_number !== null || box || exactCardrushNullModel || pixelExactOnphalos || legacyCardrushYugiohNullModel)
      && (mapping.provider !== 'onphalos' || (!box && product.franchise === 'Pokemon'))
      && (!box || ['haraka', 'cardrush'].includes(mapping.provider))
      && (mapping.provider === 'haraka' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mapping.provider_product_id) : /^\d{1,200}$/.test(mapping.provider_product_id))
      && Number.isFinite(Date.parse(mapping.verified_at))
      && (mapping.provider === 'tcgmp' ? mapping.tcgmp_product_id === mapping.provider_product_id && !!mapping.tcgmp_sku : mapping.tcgmp_product_id === null && mapping.tcgmp_sku === null)
      && ['jpg', 'png', 'webp'].some(extension => mapping.image_url === `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/${mapping.provider}/${mapping.sha256}.${extension}`)
      ? mapping.image_url : null;
    const dbCardId = verifiedImage && mapping!.provider === 'haraka' ? mapping!.provider_product_id
      : importedImage ? importedDbCard!.id : harakaImage.dbCardId;
    // Tag-only consensus never supplies an image. Reviewed mapping tags require the same exact image identity proof.
    const tag = resolveTokyoProductTag(product, dbRows,
      verifiedImage && mapping!.provider === 'haraka' ? dbCardId : importedDbCard?.id ?? null, harakaImage.identityCandidates,
      verifiedImage && (product.franchise === 'Pokemon'
        && typeof mapping!.evidence.tag_basis === 'string' && mapping!.evidence.tag_basis.trim().length > 0
        && typeof mapping!.evidence.tag_plan_sha256 === 'string' && /^[0-9a-f]{64}$/.test(mapping!.evidence.tag_plan_sha256)
        || (product.franchise === 'ONE PIECE' && mapping!.provider === 'cardrush' && typeof mapping!.evidence.source_title === 'string'
          && mapping!.evidence.source_title.trim().length > 0 && mapping!.evidence.source_title.length <= 1000))
        ? mapping!.evidence.tag : null);
    return {
      run_id: runId, raw_import_id: null, source_shinsoku_id: product.id,
      franchise: product.franchise, card_name: product.name, grade: box ? '未開封BOX' : 'PSA10',
      list_no: product.model_number, image_url: verifiedImage ?? importedImage ?? harakaImage.imageUrl ?? directShinsokuImage ?? (box ? product.image_url : null),
      alt_image_url: !verifiedImage && importedImage ? importedFallbackImage : null,
      db_card_id: dbCardId,
      rarity: null, rarity_icon_url: null, tag,
      price_high: product.price_high,
      price_low: box ? Math.min(product.price_high, calculateBoxPrice(product.source_price, noShrinkRate!)) : product.price_high,
      image_status: 'unchecked',
      source: 'shinsoku', price_source: 'shinsoku', price_source_date: result.snapshot.business_date,
    };
  });
}
