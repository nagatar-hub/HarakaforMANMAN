/**
 * 重複排除ユーティリティ
 *
 * 同一商品（franchise + list_no + card_name）+ grade + 画像URL のカードだけを
 * 重複排除する。
 * 優先順位: オーダーリスト > 旧KECAK > SPECTRE > manual
 * （同一ソースなら price_high が高い方）
 *
 * list_no だけでは同一カードの別絵を区別できず、画像URLだけでは複数商品が
 * 共通画像を使うケースを区別できない。商品情報と画像の両方が一致した場合だけ
 * 同一商品として扱う。
 * 画像URLがないカードは安全側に倒して重複排除しない。
 */

import type { PreparedCardRow } from '@haraka/shared';

const SOURCE_PRIORITY: Record<string, number> = { order_list: 3, kecak: 2, spectre: 1, manual: 0 };

function normalizedIdentityPart(value: string | null): string {
  return (value ?? '').trim().toUpperCase().replace(/[\s_!-]+/g, '');
}

/**
 * Product names and list numbers are intentionally normalized conservatively.
 * Punctuation can carry product/variant meaning, so keep it while folding
 * Unicode width, casing and repeated whitespace.
 */
function normalizedProductIdentityPart(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toUpperCase();
}

function orderListProductIdentity(card: PreparedCardRow): string {
  return card.order_list_item_id
    ?? card.excel_product_id
    ?? card.id;
}

/**
 * Query parameters may identify the image itself, so only remove the fragment
 * and a trailing slash. This intentionally mirrors the order-list matcher.
 */
function normalizedImageUrl(value: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function deduplicateByListNo(cards: PreparedCardRow[]): PreparedCardRow[] {
  const map = new Map<string, PreparedCardRow>();
  for (const card of cards) {
    const imageUrl = normalizedImageUrl(card.image_url);
    const key = imageUrl
      ? JSON.stringify([
          normalizedIdentityPart(card.franchise),
          normalizedProductIdentityPart(card.list_no),
          normalizedProductIdentityPart(card.card_name),
          normalizedIdentityPart(card.grade),
          imageUrl,
        ])
      : card.id;
    let comparisonKey = key;
    let existing = map.get(comparisonKey);
    if (!existing) {
      map.set(comparisonKey, card);
      continue;
    }
    // The order-list product ID is the lineup contract shared with Peleka.
    // Two different Excel products can legitimately reuse the same image.
    if (existing.source === 'order_list' && card.source === 'order_list') {
      const existingOrderListIdentity = orderListProductIdentity(existing);
      const orderListIdentity = orderListProductIdentity(card);
      if (existingOrderListIdentity !== orderListIdentity) {
        comparisonKey = `${key}|order-list|${JSON.stringify(orderListIdentity)}`;
        existing = map.get(comparisonKey);
        if (!existing) {
          map.set(comparisonKey, card);
          continue;
        }
      }
    }
    const existPri = SOURCE_PRIORITY[existing.source] ?? 0;
    const cardPri = SOURCE_PRIORITY[card.source] ?? 0;
    if (cardPri > existPri || (cardPri === existPri && (card.price_high ?? 0) > (existing.price_high ?? 0))) {
      map.set(comparisonKey, card);
    }
  }
  return Array.from(map.values());
}
