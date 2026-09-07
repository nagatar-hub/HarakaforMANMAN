import type { Database } from '@haraka/shared';
import type { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync.js';

/** The snapshot already contains the configured discount; never calculate it again. */
export function buildTokyoPreparedCards(runId: string, result: Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>): Database['public']['Tables']['prepared_card']['Insert'][] {
  if (result.snapshot.store !== 'manman-akihabara') throw new Error('Tokyo snapshot required');
  return result.products.map(product => {
    if (!Number.isSafeInteger(product.price_high) || product.price_high <= 0
      || !['psa', 'box'].includes(product.product_type)) throw new Error('Invalid Tokyo prepared product');
    const box = product.product_type === 'box';
    return {
      run_id: runId, raw_import_id: null, source_shinsoku_id: product.id,
      franchise: product.franchise, card_name: product.name, grade: box ? '未開封BOX' : 'PSA10',
      list_no: product.model_number, image_url: product.image_url, alt_image_url: null,
      rarity: null, rarity_icon_url: null, tag: box ? 'BOX' : 'PSA10',
      price_high: product.price_high, price_low: product.price_high, image_status: 'unchecked',
      source: 'shinsoku', price_source: 'shinsoku', price_source_date: result.snapshot.business_date,
    };
  });
}
