import {
  calculatePsa10PriceLow,
  normalizeStorePricingSettings,
  type PreparedCardRow,
  type Franchise,
  type Psa10DiscountRates,
  type StorePricingSettings,
} from '@haraka/shared';
import type { createSupabaseClientFromSecrets } from './supabase.js';

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;

function isPsa10(grade: string | null): boolean {
  return grade?.trim().toUpperCase() === 'PSA10';
}

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
  psa10DiscountRates: Psa10DiscountRates,
): PreparedCardRow[] {
  return cards.map((card) => {
    const discountRate = psa10DiscountRates[card.franchise as Franchise];
    if (!isPsa10(card.grade) || typeof discountRate !== 'number' || !card.price_high || card.price_high <= 0) {
      return card;
    }

    return {
      ...card,
      price_low: calculatePsa10PriceLow(card.price_high, discountRate),
    };
  });
}
