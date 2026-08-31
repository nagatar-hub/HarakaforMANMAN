import type {
  CustomBuybackProductType,
  LayoutTemplateRow,
  PreparedCardRow,
} from '../types/database.js';

export const CUSTOM_BUYBACK_MAX_ITEMS = 400;

export type CustomBuybackCatalogCard = Pick<
  PreparedCardRow,
  | 'id'
  | 'db_card_id'
  | 'excel_product_id'
  | 'franchise'
  | 'card_name'
  | 'grade'
  | 'list_no'
  | 'rarity'
  | 'rarity_icon_url'
  | 'tag'
  | 'image_url'
  | 'alt_image_url'
  | 'image_status'
  | 'price_high'
  | 'price_low'
  | 'price_source'
  | 'price_source_date'
>;

export type CustomLayoutCandidate = Pick<
  LayoutTemplateRow,
  'id' | 'slug' | 'total_slots' | 'priority' | 'is_active'
>;

export type CustomPagePlan<L extends CustomLayoutCandidate = CustomLayoutCandidate> = {
  pageIndex: number;
  layout: L;
  itemIds: string[];
};

export function tokyoBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isCustomBuybackCatalogCard(
  card: Pick<PreparedCardRow, 'grade' | 'tag' | 'price_high' | 'price_low'>,
  productType: CustomBuybackProductType,
): boolean {
  const tag = card.tag?.trim().toUpperCase() ?? '';
  if (productType === 'box') {
    return tag === 'BOX' && card.price_high != null && card.price_high > 0;
  }
  const grade = card.grade?.replace(/\s+/g, '').toUpperCase() ?? '';
  return tag !== 'BOX'
    && grade.startsWith('PSA')
    && card.price_high != null
    && card.price_high > 0
    && card.price_low != null
    && card.price_low > 0;
}

export function selectCustomLayoutCombination<L extends CustomLayoutCandidate>(
  itemCount: number,
  candidates: L[],
  productType: CustomBuybackProductType,
): L[] | null {
  if (itemCount <= 0) return [];
  const active = candidates.filter((layout) => layout.is_active && layout.total_slots > 0);
  if (active.length === 0) return null;
  const eligible = active.filter(layout => layout.slug.startsWith('box_') === (productType === 'box'));
  if (eligible.length === 0) return null;

  const bySlot = new Map<number, L>();
  for (const layout of eligible) {
    const current = bySlot.get(layout.total_slots);
    if (!current || layout.priority > current.priority) bySlot.set(layout.total_slots, layout);
  }
  const sizes = [...bySlot.keys()].sort((a, b) => a - b);
  const maxSlot = sizes.at(-1);
  if (!maxSlot) return null;
  const upperBound = itemCount + maxSlot;
  const dp: Array<number[] | null> = new Array(upperBound + 1).fill(null);
  dp[0] = [];

  for (let sum = 1; sum <= upperBound; sum += 1) {
    let best: number[] | null = null;
    for (const size of sizes) {
      if (size > sum) break;
      const previous = dp[sum - size];
      if (!previous) continue;
      const candidate = [...previous, size].sort((a, b) => a - b);
      if (!best || isBetterLayoutSizes(candidate, best)) best = candidate;
    }
    dp[sum] = best;
  }

  let best: number[] | null = null;
  for (let sum = itemCount; sum <= upperBound; sum += 1) {
    const candidate = dp[sum];
    if (candidate && (!best || candidate.length < best.length)) best = candidate;
  }
  return best?.map((size) => bySlot.get(size)!) ?? null;
}

export function planCustomBuybackPages<L extends CustomLayoutCandidate>(
  itemIds: string[],
  candidates: L[],
  productType: CustomBuybackProductType,
): CustomPagePlan<L>[] | null {
  const layouts = selectCustomLayoutCombination(itemIds.length, candidates, productType);
  if (!layouts) return null;
  let cursor = 0;
  return layouts.map((layout, pageIndex) => {
    const pageItemIds = itemIds.slice(cursor, cursor + layout.total_slots);
    cursor += layout.total_slots;
    return { pageIndex, layout, itemIds: pageItemIds };
  });
}

function isBetterLayoutSizes(candidate: number[], current: number[]): boolean {
  if (candidate.length !== current.length) return candidate.length < current.length;
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== current[index]) return candidate[index] < current[index];
  }
  return false;
}
