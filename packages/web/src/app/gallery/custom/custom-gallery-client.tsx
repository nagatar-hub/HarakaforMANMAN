'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { downloadImagesAsZip } from '@/lib/download-images';
import { safeDownloadName } from '@/app/custom-buyback/custom-buyback-state';
import { groupCustomGalleryEntries, type CustomGalleryEntry } from './custom-gallery-state';

const FRANCHISE_JA: Record<string, string> = {
  Pokemon: 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

function imageLoader({ src }: { src: string }) { return src; }

export function CustomGalleryClient() {
  const [entries, setEntries] = useState<CustomGalleryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/custom-buyback/gallery', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as CustomGalleryEntry[] | { error?: string };
        if (!response.ok) throw new Error(!Array.isArray(payload) && payload.error ? payload.error : 'カスタムギャラリーを取得できません');
        if (active) setEntries(payload as CustomGalleryEntry[]);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const groups = useMemo(() => groupCustomGalleryEntries(entries), [entries]);

  async function download(entry: CustomGalleryEntry) {
    if (entry.pages.length === 0) return;
    setDownloading(entry.sheet.id);
    try {
      await downloadImagesAsZip(entry.pages.map((page) => ({
        image_url: page.image_url!,
        filename: `${safeDownloadName(entry.sheet.name)}_${String(page.page_index + 1).padStart(2, '0')}.png`,
      })), `${safeDownloadName(entry.sheet.name)}.zip`);
    } finally {
      setDownloading(null);
    }
  }

  if (loading) return <div className="rounded-2xl border border-border-card bg-card-bg p-12 text-center text-text-secondary">読み込み中...</div>;
  if (error) return <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-5 text-sm text-red-800">{error}</div>;
  if (groups.length === 0) return <div className="rounded-2xl border-2 border-dashed border-warm-300 p-12 text-center"><p className="text-text-secondary">カスタム買取表はまだありません</p><Link href="/custom-buyback" className="mt-4 inline-block rounded-full bg-text-primary px-5 py-2.5 text-sm font-bold text-white">最初の表を作る</Link></div>;

  return <div className="space-y-10">{groups.map((group) => <section key={group.date}>
    <div className="mb-4 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-accent">Display date</p><h2 className="text-2xl font-bold text-text-primary">{group.date}</h2></div><span className="text-xs text-text-secondary">{group.entries.length}表</span></div>
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{group.entries.map((entry) => {
      const cover = entry.pages[0]?.image_url;
      return <article key={entry.sheet.id} className="overflow-hidden rounded-2xl border border-border-card bg-card-bg">
        <div className="relative aspect-[4/3] bg-warm-100">{cover ? <Image loader={imageLoader} unoptimized fill sizes="(max-width: 768px) 100vw, 33vw" src={cover} alt={`${entry.sheet.name}のプレビュー`} className="object-contain" /> : <div className="flex h-full items-center justify-center text-sm text-text-secondary">画像はまだ生成されていません</div>}</div>
        <div className="p-4"><div className="mb-2 flex items-start justify-between gap-3"><h3 className="min-w-0 truncate text-lg font-bold">{entry.sheet.name}</h3><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${statusClass(entry.sheet.status)}`}>{statusLabel(entry.sheet.status)}</span></div>
          <p className="text-xs text-text-secondary">{FRANCHISE_JA[entry.sheet.franchise] ?? entry.sheet.franchise} · {entry.sheet.product_type.toUpperCase()} · {entry.sheet.kind === 'store' ? '店頭用' : '郵送用'}</p>
          <p className="mt-1 text-xs text-text-secondary">{entry.pages.length}ページ · 価格基準日 {entry.sheet.price_business_date}</p>
          <p className="mt-1 text-[10px] text-text-secondary">作成日時 {formatCreatedAt(entry.sheet.created_at)}</p>
          <div className="mt-4 flex gap-2"><Link href={`/custom-buyback?sheet=${encodeURIComponent(entry.sheet.id)}`} className="flex-1 rounded-xl bg-text-primary px-4 py-2.5 text-center text-xs font-bold text-white">この表を開く</Link><button type="button" disabled={entry.pages.length === 0 || downloading === entry.sheet.id} onClick={() => void download(entry)} className="rounded-xl border border-border-card bg-white px-4 py-2.5 text-xs font-bold disabled:opacity-40">{downloading === entry.sheet.id ? '保存中...' : 'ZIP保存'}</button></div>
        </div>
      </article>;
    })}</div>
  </section>)}</div>;
}

function statusLabel(status: CustomGalleryEntry['sheet']['status']): string {
  return ({ draft: '再生成待ち', rendering: '画像生成中', ready: '生成済み', failed: '要確認' } as const)[status];
}

function statusClass(status: CustomGalleryEntry['sheet']['status']): string {
  return status === 'ready' ? 'bg-green-100 text-green-700'
    : status === 'rendering' ? 'bg-blue-100 text-blue-700'
      : status === 'failed' ? 'bg-red-100 text-red-700'
        : 'bg-warm-100 text-warm-700';
}

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
