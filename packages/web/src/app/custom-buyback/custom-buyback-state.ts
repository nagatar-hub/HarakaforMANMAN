import type { CustomBuybackItemRow } from '@haraka/shared';

export function reorderCustomBuybackItems(items: CustomBuybackItemRow[], itemIds: string[]): CustomBuybackItemRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (itemIds.length !== items.length || new Set(itemIds).size !== items.length || itemIds.some((id) => !byId.has(id))) {
    throw new Error('並び順は全カードを重複なく含める必要があります');
  }
  return itemIds.map((id, position) => ({ ...byId.get(id)!, position }));
}

export function customBuybackCsv(items: CustomBuybackItemRow[]): string {
  const rows: Array<Array<string | number | null>> = [
    ['位置', '商品名', 'グレード', 'リスト番号', 'レアリティ', '元価格', '表示価格', '募集数', '最高価格店舗', '手修正理由', '価格基準日', '買取Checker商品ID', 'Excel商品ID'],
    ...items.map((item) => [
      item.position + 1, item.card_name, item.grade, item.list_no, item.rarity,
      item.source_price_high, item.final_price_high, item.demand, item.source_shop_name,
      item.override_reason, item.price_source_date, item.source_kaitori_product_id, item.excel_product_id,
    ]),
  ];
  const escape = (value: string | number | null) => {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}\r\n`;
}

export function safeDownloadName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
  return (normalized || 'custom-buyback').slice(0, 80);
}
