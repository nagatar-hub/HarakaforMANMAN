type GalleryPricing = {
  listings: { store: string; price: number | null }[];
  adopted: { store: string | null; price: number | null } | null;
};

const priceText = (price: number | null) => price === null ? '価格未記録' : `¥${price.toLocaleString('ja-JP')}`;

/** Historical source prices, separate from the editable buyback prices. */
export function GalleryCardPricing({ pricing }: { pricing?: GalleryPricing }) {
  if (!pricing) return null;
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
