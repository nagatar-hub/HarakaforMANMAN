import {
  normalizeStorePricingSettings,
  type PreparedCardRow,
  type Psa10DiscountRates,
  type StorePricingSettings,
} from '@haraka/shared';
import type { createSupabaseClientFromSecrets } from './supabase.js';

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;

export async function loadPsa10DiscountRates(
  supabase: SupabaseClient,
  storeName: string,
): Promise<Psa10DiscountRates> {
  return (await loadStorePricingSettings(supabase, storeName)).psa10_discount_rates;
}

export async function loadStorePricingSettings(
  supabase: SupabaseClient,
  storeName: string,
): Promise<StorePricingSettings> {
  const { data: storeConfig } = await supabase
    .from('store_config')
    .select('settings')
    .eq('store', storeName)
    .single();

  return normalizeStorePricingSettings(storeConfig?.settings);
}

export function applyCurrentPsa10DiscountRates(
  cards: PreparedCardRow[],
  _psa10DiscountRates: Psa10DiscountRates,
): PreparedCardRow[] {
  // 商材別減額率は sync 時に price_high へ反映する。
  // generated_page からの再生成では元価格を持たないため、既存の prepared_card 価格をそのまま使う。
  return cards;
}
