type GalleryPricing = {
  listings: { store: string; price: number | null }[];
  adopted: { store: string | null; price: number | null } | null;
  comparison?: {
    rows: { store: string; rawPrice: number; highRate: number; highPrice: number;
      lowRate: number; lowPrice: number; selectedHigh: boolean; selectedLow: boolean }[];
    high: { store: string; price: number };
    low: { store: string; price: number };
  };
};

const priceText = (price: number | null) => price === null ? '価格未記録' : `¥${price.toLocaleString('ja-JP')}`;

/** Historical source prices, separate from the editable buyback prices. */
export function GalleryCardPricing({ pricing }: { pricing?: GalleryPricing }) {
  if (!pricing) return null;
  if (pricing.comparison) return <div className="mt-2 space-y-2 text-xs text-text-secondary break-words">
    <p className="font-medium">生成時の店舗別価格比較</p>
    <div className="overflow-x-auto">
      <table className="min-w-[620px] border-separate border-spacing-y-1 text-left">
        <thead><tr>
          <th className="pr-3 font-medium">店舗</th><th className="px-2 font-medium">当日元価格</th>
          <th className="px-2 font-medium">上限率</th><th className="px-2 font-medium">上限結果</th>
          <th className="px-2 font-medium">下限率</th><th className="pl-2 font-medium">下限結果</th>
        </tr></thead>
        <tbody>{pricing.comparison.rows.map(row => <tr key={row.store}>
          <th className="pr-3 font-medium text-text-primary">{row.store}</th>
          <td className="px-2 tabular-nums">{priceText(row.rawPrice)}</td>
          <td className="px-2 tabular-nums">{row.highRate * 100}%</td>
          <td className="px-2 tabular-nums">{priceText(row.highPrice)}{row.selectedHigh ? '（採用）' : ''}</td>
          <td className="px-2 tabular-nums">{row.lowRate * 100}%</td>
          <td className="pl-2 tabular-nums">{priceText(row.lowPrice)}{row.selectedLow ? '（採用）' : ''}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="text-text-primary">採用上限：{pricing.comparison.high.store}{' '}
      <span className="tabular-nums">{priceText(pricing.comparison.high.price)}</span>
    </p>
    <p className="text-text-primary">採用下限：{pricing.comparison.low.store}{' '}
      <span className="tabular-nums">{priceText(pricing.comparison.low.price)}</span>
    </p>
  </div>;
  return <div className="mt-2 space-y-1 text-xs text-text-secondary break-words">
    <p className="font-medium">生成時の掲載店舗・価格</p>
    {pricing.listings.length ? <dl className="space-y-0.5">
      {pricing.listings.map((listing, index) => <div key={`${listing.store}-${index}`} className="flex flex-wrap gap-x-2">
        <dt>{listing.store}</dt>
        <dd className="tabular-nums">{priceText(listing.price)}</dd>
      </div>)}
    </dl> : <p>掲載元情報未記録</p>}
    {pricing.adopted && <p className="text-text-primary">
      計算元（減額前）：{pricing.adopted.store ?? '採用店舗未記録'}{' '}
      <span className="tabular-nums">{priceText(pricing.adopted.price)}</span>
    </p>}
  </div>;
}
