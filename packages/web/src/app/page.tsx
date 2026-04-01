import { createServerSupabase } from '@/lib/supabase-server';
import Link from 'next/link';
import type { RunRow } from '@haraka/shared';

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-[#f3faf0] text-[#2d5a2f] border-[#bfd4b8]',
  running: 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse',
  failed: 'bg-[#fff0ec] text-[#8d3a22] border-[#e3b0a2]',
};

function formatDate(iso: string | null) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export default async function DashboardPage() {
  const supabase = createServerSupabase();

  const { data: rawRun } = await supabase
    .from('run')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const run = rawRun as RunRow | null;

  let untaggedCount = 0;
  let recentPages: { id: string; franchise: string; page_label: string | null; image_url: string | null }[] = [];

  if (run) {
    const { count } = await supabase
      .from('prepared_card')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .is('tag', null);
    untaggedCount = count ?? 0;

    const { data: pages } = await supabase
      .from('generated_page')
      .select('id, franchise, page_label, image_url')
      .eq('run_id', run.id)
      .eq('status', 'generated')
      .order('franchise')
      .order('page_index')
      .limit(6);
    recentPages = (pages ?? []) as typeof recentPages;
  }

  return (
    <div>
      {/* Hero */}
      <div className="mb-14">
        <h1 className="font-[family-name:var(--font-display)] text-3xl sm:text-5xl font-bold tracking-tight text-text-primary">Haraka</h1>
        <p className="text-text-secondary mt-2 sm:mt-3 text-base sm:text-lg">買取表自動生成</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 mb-8 sm:mb-14">
        <div className="bg-card-bg border border-border-card rounded-2xl p-5 sm:p-8 hover:scale-[1.02] transition-transform duration-300">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-text-secondary mb-3">最新ラン</p>
          <hr className="border-border-card mb-5" />
          {run ? (
            <>
              <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold border ${STATUS_STYLES[run.status] || 'bg-warm-100 text-warm-500'}`}>
                {run.status}
              </span>
              <p className="text-base text-text-secondary mt-4">{formatDate(run.started_at)}</p>
            </>
          ) : (
            <p className="text-text-secondary">実行履歴なし</p>
          )}
        </div>

        <div className="bg-card-bg border border-border-card rounded-2xl p-5 sm:p-8 hover:scale-[1.02] transition-transform duration-300">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-text-secondary mb-3">統計</p>
          <hr className="border-border-card mb-5" />
          {run ? (
            <div className="space-y-3 text-base">
              <div className="flex justify-between items-baseline">
                <span className="text-text-secondary">取込</span>
                <span className="text-2xl font-bold text-text-primary">{run.total_imported}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-text-secondary">準備完了</span>
                <span className="text-2xl font-bold text-text-primary">{run.total_prepared}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-text-secondary">ページ</span>
                <span className="text-2xl font-bold text-text-primary">{run.total_pages}</span>
              </div>
            </div>
          ) : (
            <p className="text-text-secondary">-</p>
          )}
        </div>

        <Link href="/tags" className="bg-card-bg border border-border-card rounded-2xl p-5 sm:p-8 hover:scale-[1.02] transition-transform duration-300 group">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-text-secondary mb-3">タグ未設定</p>
          <hr className="border-border-card mb-5" />
          <p className="text-5xl font-black text-text-primary">
            {untaggedCount}
            <span className="text-lg font-normal text-text-secondary ml-2">件</span>
          </p>
          {untaggedCount > 0 && (
            <p className="text-sm text-text-primary font-semibold mt-3 group-hover:translate-x-1 transition-transform duration-200">
              対応が必要です &rarr;
            </p>
          )}
        </Link>
      </div>

      {/* Recent images */}
      {recentPages && recentPages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-text-primary">最新の生成画像</h2>
            <Link href="/gallery" className="text-base text-text-primary underline underline-offset-4 hover:no-underline font-medium">
              すべて見る &rarr;
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            {recentPages.map((page) => (
              <div key={page.id} className="bg-card-bg border border-border-card rounded-xl overflow-hidden hover:scale-[1.03] transition-transform duration-300">
                {page.image_url && (
                  <img src={page.image_url} alt={page.page_label || ''} className="w-full h-auto" loading="lazy" />
                )}
                <div className="px-5 py-4 text-sm text-text-secondary font-medium">
                  {page.franchise} / {page.page_label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
