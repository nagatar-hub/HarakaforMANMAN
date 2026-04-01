/**
 * 重複排除ユーティリティ
 *
 * 同一 list_no + grade のカードを重複排除する。
 * 優先順位: KECAK > SPECTRE > manual（同一ソースなら price_high が高い方）
 * list_no がない場合は card.id をキーとして重複排除しない。
 */

import type { PreparedCardRow } from '@haraka/shared';

const SOURCE_PRIORITY: Record<string, number> = { kecak: 2, spectre: 1, manual: 0 };

export function deduplicateByListNo(cards: PreparedCardRow[]): PreparedCardRow[] {
  const map = new Map<string, PreparedCardRow>();
  for (const card of cards) {
    const key = card.list_no
      ? `${card.list_no}|${card.grade ?? ''}`
      : card.id;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, card);
      continue;
    }
    const existPri = SOURCE_PRIORITY[existing.source] ?? 0;
    const cardPri = SOURCE_PRIORITY[card.source] ?? 0;
    if (cardPri > existPri || (cardPri === existPri && (card.price_high ?? 0) > (existing.price_high ?? 0))) {
      map.set(key, card);
    }
  }
  return Array.from(map.values());
}
