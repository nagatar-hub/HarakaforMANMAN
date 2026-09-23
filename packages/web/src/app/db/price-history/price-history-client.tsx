'use client';

import { useState, type ComponentProps, type FormEvent } from 'react';
import { FRANCHISE_JA } from '@haraka/shared';
import { GalleryCardPricing } from '@/components/gallery-card-pricing';

type Pricing = NonNullable<ComponentProps<typeof GalleryCardPricing>['pricing']> & {
  comparison?: { low?: { store: string; price: number } };
};

type Entry = {
  kind: 'regular' | 'custom';
  id: string;
  published_at: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
  pricing?: Pricing;
  custom?: {
    sheet_name: string;
    display_date: string;
    rendered_by: string | null;
    sheet_created_by: string | null;
    source_shop_name: string | null;
    override_reason: string | null;
    backfilled: boolean;
  };
};

const API_URL = '/api/backend';
const yen = (value: number | null) => (value === null ? '—' : `¥${Number(value).toLocaleString('ja-JP')}`);
const jst = (value: string) => new Date(value).toLocaleString('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** 採用した仕入れ元（上限・下限が別の店舗なら両方） */
function sourceLabel(entry: Entry): string {
  if (entry.kind === 'custom') return entry.custom?.source_shop_name ?? '未記録';
  const comparison = entry.pricing?.comparison;
  if (comparison) {
    const low = comparison.low?.store;
    return low && low !== comparison.high.store ? `上限 ${comparison.high.store} / 下限 ${low}` : comparison.high.store;
  }
  return entry.pricing?.adopted?.store ?? '未記録';
}

export function PriceHistoryClient() {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/gallery/price-history?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? '検索に失敗しました');
      setEntries(body.entries);
      setTruncated(body.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : '検索に失敗しました');
    }
    setLoading(false);
  };

  return (
    <div>
      <h1 className="page-title text-2xl sm:text-4xl text-text-primary">掲載履歴</h1>
      <p className="text-sm text-text-secondary mt-2">商品名または型番で、買取表にいつ・いくらで掲載されたかを新しい順に表示します。</p>

      <form onSubmit={search} className="flex gap-2 mt-6 mb-6 max-w-xl">
        <label htmlFor="price-history-q" className="sr-only">商品名・型番</label>
        <input
          id="price-history-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={100}
          placeholder="商品名・型番（例: ピカチュウ / 227/187）"
          className="flex-1 min-w-0 px-3 py-2 text-sm border border-border-card rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#b8a080]"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-4 py-2 text-sm font-medium bg-[#b8a080] text-white rounded-lg hover:bg-[#a08060] disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {loading ? '検索中...' : '検索'}
        </button>
      </form>

      {error && <p role="alert" className="text-sm text-red-600 mb-4">{error}</p>}
      {entries && entries.length === 0 && <p className="text-text-secondary">掲載履歴が見つかりませんでした。</p>}
      {truncated && (
        <p className="text-xs text-orange-600 mb-3">該当件数が多いため新しいものから一部のみ表示しています。検索語を絞り込んでください。</p>
      )}

      {entries && entries.length > 0 && (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.id}`} className="bg-card-bg border border-border-card rounded-2xl px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <time dateTime={entry.published_at} className="text-sm font-bold tabular-nums text-text-primary">{jst(entry.published_at)}</time>
                {entry.kind === 'custom' ? (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-orange-50 text-orange-700 border border-orange-200">カスタム</span>
                ) : (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-text-primary/10 text-text-primary">通常</span>
                )}
                <span className="text-xs text-text-secondary">{FRANCHISE_JA[entry.franchise as keyof typeof FRANCHISE_JA] ?? entry.franchise}</span>
              </div>
              <p className="mt-1 text-sm text-text-primary break-words">
                {entry.card_name}
                {entry.grade && <span className="ml-2 text-text-secondary">{entry.grade}</span>}
                {entry.list_no && <span className="ml-2 text-text-secondary">{entry.list_no}</span>}
              </p>
              <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                <div className="flex gap-1"><dt className="text-text-secondary">掲載価格</dt>
                  <dd className="font-bold tabular-nums text-text-primary">
                    {entry.price_low !== null && entry.price_low !== entry.price_high
                      ? `上限 ${yen(entry.price_high)} / 下限 ${yen(entry.price_low)}`
                      : yen(entry.price_high)}
                  </dd>
                </div>
                <div className="flex gap-1"><dt className="text-text-secondary">採用元</dt><dd className="text-text-primary">{sourceLabel(entry)}</dd></div>
              </dl>
              {entry.custom && (
                <p className="mt-1 text-xs text-text-secondary break-words">
                  {entry.custom.sheet_name}（表示日 {entry.custom.display_date}）
                  ・生成者 {entry.custom.rendered_by ?? (entry.custom.backfilled ? '記録開始前のため不明' : '未記録')}
                  {entry.custom.sheet_created_by && entry.custom.sheet_created_by !== entry.custom.rendered_by
                    && ` ・表の作成者 ${entry.custom.sheet_created_by}`}
                  {entry.custom.override_reason && ` ・手修正: ${entry.custom.override_reason}`}
                </p>
              )}
              {entry.pricing && (entry.pricing.comparison || entry.pricing.listings.length > 0) && (
                <details className="mt-1">
                  <summary className="text-xs text-text-secondary cursor-pointer">他の仕入れ元の価格</summary>
                  <GalleryCardPricing pricing={entry.pricing} />
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
