const BUILT_IN_EXCLUDED_ORDER_LIST_CARD_NAME = 'なにかのPSA10';

/**
 * 全店舗共通で買取表に掲載しないExcel商品名を判定する。
 *
 * Excel側で付与される先頭の【…】装飾と空白だけを正規化し、
 * 似た商品名の部分一致は除外対象にしない。
 */
export function isBuiltInOrderListExclusion(
  cardName: string | null | undefined,
): boolean {
  return (cardName ?? '')
    .trim()
    .replace(/^\u3010[^\u3011]+\u3011\s*/, '')
    .replace(/[\s\u3000]/g, '')
    .toUpperCase() === BUILT_IN_EXCLUDED_ORDER_LIST_CARD_NAME.toUpperCase();
}
