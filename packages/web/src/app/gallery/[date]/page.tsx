'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { FranchiseTabs } from '@/components/franchise-tabs';
import { ImageModal } from '@/components/image-modal';
import { PageDetailModal } from './page-detail-modal';
import { fetchImagesAsFiles, shareFiles, downloadFilesAsZip, isShareSupported } from '@/lib/download-images';
import type { DownloadableImage } from '@/lib/download-images';

type PageImage = {
  id: string;
  run_id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  card_ids: string[];
  image_url: string | null;
  run_started_at: string;
};

const FRANCHISE_JA: Record<string, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function GalleryDatePage() {
  const { date } = useParams<{ date: string }>();
  const [images, setImages] = useState<PageImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [collapsedRuns, setCollapsedRuns] = useState<Set<string>>(new Set());
  const [detailPageId, setDetailPageId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState({ current: 0, total: 0 });
  const [readyFiles, setReadyFiles] = useState<File[] | null>(null);
  const [readyZipName, setReadyZipName] = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
      try {
        const res = await fetch(`${apiUrl}/api/gallery/images?date=${date}`);
        if (res.ok) {
          const data: PageImage[] = await res.json();
          setImages(data);

          // 最新run以外を折りたたむ
          const runIds = [...new Set(data.map(d => d.run_id))];
          if (runIds.length > 1) {
            // run_started_at降順で最初のrun_idが最新
            const sorted = [...new Map(data.map(d => [d.run_id, d.run_started_at]))].sort((a, b) => b[1].localeCompare(a[1]));
            const oldRuns = new Set(sorted.slice(1).map(s => s[0]));
            setCollapsedRuns(oldRuns);
          }
        }
      } catch {
        // ignore
      }
      setLoading(false);
    }
    load();
  }, [date]);

  const filtered = filter === 'all'
    ? images
    : images.filter((img) => img.franchise === filter);

  // run_id単位でグループ化（最新順）
  const runGroups = (() => {
    const map = new Map<string, { started_at: string; pages: PageImage[] }>();
    for (const img of filtered) {
      if (!map.has(img.run_id)) {
        map.set(img.run_id, { started_at: img.run_started_at, pages: [] });
      }
      map.get(img.run_id)!.pages.push(img);
    }
    return [...map.entries()].sort((a, b) => b[1].started_at.localeCompare(a[1].started_at));
  })();

  const hasMultipleRuns = runGroups.length > 1;

  function toggleRun(runId: string) {
    setCollapsedRuns(prev => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  // 全filtered画像のフラット配列（モーダル用）
  const allFiltered = runGroups.flatMap(([, g]) => g.pages);

  function buildDownloadList(pages: PageImage[]): DownloadableImage[] {
    return pages
      .filter(p => p.image_url)
      .map(p => ({
        image_url: p.image_url!,
        filename: `${p.franchise}_${p.page_label || `page-${p.page_index}`}.png`,
      }));
  }

  async function handleBulkDownload() {
    const list = buildDownloadList(allFiltered);
    if (list.length === 0) return;
    setDownloading(true);
    setDlProgress({ current: 0, total: list.length });
    const files = await fetchImagesAsFiles(list, (cur, total) => setDlProgress({ current: cur, total }));
    if (files.length === 0) { setDownloading(false); return; }
    // Web Share対応 → 「共有する」ボタン表示待ち
    if (isShareSupported()) {
      setReadyFiles(files);
      setReadyZipName(`haraka_${date}.zip`);
      return; // overlayで共有/ZIPボタン表示
    }
    // 非対応 → 直接ZIP
    await downloadFilesAsZip(files, `haraka_${date}.zip`);
    setDownloading(false);
  }

  async function handleSelectedDownload() {
    const selected = allFiltered.filter(p => selectedIds.has(p.id));
    const list = buildDownloadList(selected);
    if (list.length === 0) return;
    setDownloading(true);
    setDlProgress({ current: 0, total: list.length });
    const files = await fetchImagesAsFiles(list, (cur, total) => setDlProgress({ current: cur, total }));
    if (files.length === 0) { setDownloading(false); return; }
    if (isShareSupported()) {
      setReadyFiles(files);
      setReadyZipName(`haraka_${date}_selected.zip`);
      return;
    }
    await downloadFilesAsZip(files, `haraka_${date}_selected.zip`);
    setDownloading(false);
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function handleShare() {
    if (!readyFiles) return;
    const shared = await shareFiles(readyFiles);
    if (!shared) {
      // 共有失敗 → ZIPフォールバック
      await downloadFilesAsZip(readyFiles, readyZipName);
    }
    setReadyFiles(null);
    setDownloading(false);
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function handleZipFallback() {
    if (!readyFiles) return;
    await downloadFilesAsZip(readyFiles, readyZipName);
    setReadyFiles(null);
    setDownloading(false);
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function handleDlCancel() {
    setReadyFiles(null);
    setDownloading(false);
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      {/* Download progress / share overlay */}
      {downloading && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card-bg border border-border-card rounded-2xl shadow-2xl p-8 w-80">
            {readyFiles ? (
              <>
                <p className="text-sm font-semibold text-text-primary mb-1">準備完了！</p>
                <p className="text-xs text-text-secondary mb-4">{readyFiles.length}枚の画像</p>
                <div className="space-y-2">
                  <button
                    onClick={handleShare}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold bg-text-primary text-white hover:opacity-90 transition-opacity"
                  >
                    共有する（写真に保存）
                  </button>
                  <button
                    onClick={handleZipFallback}
                    className="w-full py-2.5 rounded-xl text-sm font-medium border border-border-card text-text-secondary hover:bg-warm-100 transition-colors"
                  >
                    ZIPでダウンロード
                  </button>
                  <button
                    onClick={handleDlCancel}
                    className="w-full py-2 rounded-xl text-xs text-text-secondary hover:text-text-primary transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-text-primary mb-3">画像を準備中...</p>
                <div className="w-full bg-warm-100 rounded-full h-2 overflow-hidden mb-2">
                  <div
                    className="bg-text-primary h-2 rounded-full transition-all duration-300"
                    style={{ width: `${dlProgress.total > 0 ? Math.round((dlProgress.current / dlProgress.total) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-text-secondary text-right">{dlProgress.current}/{dlProgress.total}</p>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 sm:mb-14">
        <div>
          <Link href="/gallery" className="text-sm text-text-secondary hover:text-text-primary transition-colors mb-1 inline-block">&larr; ギャラリー</Link>
          <h1 className="page-title text-2xl sm:text-4xl text-text-primary">{date}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <FranchiseTabs active={filter} onChange={setFilter} />
          {!selectMode ? (
            <>
              <button
                onClick={handleBulkDownload}
                disabled={downloading || allFiltered.length === 0}
                className="px-4 py-2 rounded-full text-sm font-semibold border border-border-card text-text-primary hover:bg-warm-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                一括DL
              </button>
              <button
                onClick={() => { setSelectMode(true); setSelectedIds(new Set()); }}
                disabled={downloading || allFiltered.length === 0}
                className="px-4 py-2 rounded-full text-sm font-semibold border border-border-card text-text-primary hover:bg-warm-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                選択DL
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleSelectedDownload}
                disabled={downloading || selectedIds.size === 0}
                className="px-4 py-2 rounded-full text-sm font-semibold bg-text-primary text-white hover:bg-warm-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ダウンロード ({selectedIds.size}件)
              </button>
              <button
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                className="px-4 py-2 rounded-full text-sm border border-border-card text-text-secondary hover:bg-warm-50 transition-colors"
              >
                キャンセル
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-text-secondary">読み込み中...</p>
      ) : filtered.length === 0 ? (
        <p className="text-text-secondary">画像がありません</p>
      ) : (
        <>
          {runGroups.map(([runId, group], runIdx) => {
            const isCollapsed = collapsedRuns.has(runId);
            // runGroupsのstartIdxを計算（モーダルナビ用）
            let startIdx = 0;
            for (let i = 0; i < runIdx; i++) startIdx += runGroups[i][1].pages.length;

            // franchise別にグループ化
            const franchiseGroups = new Map<string, PageImage[]>();
            for (const img of group.pages) {
              const list = franchiseGroups.get(img.franchise) || [];
              list.push(img);
              franchiseGroups.set(img.franchise, list);
            }

            return (
              <div key={runId} className="mb-10">
                {/* Run header（複数実行がある場合のみ表示） */}
                {hasMultipleRuns && (
                  <button
                    onClick={() => toggleRun(runId)}
                    className="flex items-center gap-3 mb-5 group"
                  >
                    <span className="text-sm text-text-secondary">
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span className="text-base font-semibold text-text-primary">
                      {formatTime(group.started_at)} の実行
                    </span>
                    <span className="text-sm text-text-secondary">
                      ({group.pages.length}ページ)
                    </span>
                    {runIdx === 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#f3faf0] text-[#2d5a2f] border border-[#bfd4b8]">最新</span>
                    )}
                  </button>
                )}

                {!isCollapsed && Array.from(franchiseGroups.entries()).map(([franchise, pages]) => {
                  const franchiseStart = startIdx + group.pages.indexOf(pages[0]);
                  return (
                    <div key={`${runId}-${franchise}`} className="mb-12">
                      <h2 className="text-2xl font-bold text-text-primary mb-5">
                        {FRANCHISE_JA[franchise] || franchise}
                        <span className="text-base text-text-secondary font-normal ml-3">{pages.length}ページ</span>
                      </h2>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-6">
                        {pages.map((page, i) => (
                          <div key={page.id} className={`bg-card-bg border rounded-xl overflow-hidden hover:scale-[1.03] transition-all duration-300 relative ${selectMode && selectedIds.has(page.id) ? 'border-text-primary ring-2 ring-text-primary/30' : 'border-border-card'}`}>
                            {selectMode && (
                              <button
                                onClick={() => toggleSelect(page.id)}
                                className="absolute top-2 left-2 z-10 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-colors bg-white/80 backdrop-blur-sm"
                                style={{ borderColor: selectedIds.has(page.id) ? 'var(--color-text-primary)' : '#ccc' }}
                              >
                                {selectedIds.has(page.id) && <span className="text-text-primary text-sm font-bold">✓</span>}
                              </button>
                            )}
                            <button
                              onClick={() => selectMode ? toggleSelect(page.id) : setModalIndex(franchiseStart + i)}
                              className="w-full text-left"
                            >
                              {page.image_url && (
                                <img src={`${page.image_url}?t=${Date.now()}`} alt={page.page_label || ''} className="w-full h-auto" loading="lazy" />
                              )}
                            </button>
                            <div className="px-4 py-3 flex items-center justify-between">
                              <div>
                                <p className="text-base font-semibold text-text-primary truncate">{page.page_label || `page-${page.page_index}`}</p>
                                <p className="text-sm text-text-secondary mt-0.5">{page.card_ids.length}枚</p>
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); setDetailPageId(page.id); }}
                                className="text-xs px-3 py-1.5 rounded-lg border border-border-card text-text-secondary hover:bg-warm-100 hover:text-text-primary transition-colors"
                                title="データ詳細"
                              >
                                詳細
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      )}

      {modalIndex !== null && (
        <ImageModal
          images={allFiltered}
          currentIndex={modalIndex}
          onClose={() => setModalIndex(null)}
          onNavigate={setModalIndex}
        />
      )}

      {detailPageId && (
        <PageDetailModal
          pageId={detailPageId}
          onClose={() => setDetailPageId(null)}
          onRegenerated={() => {
            // 再生成後に画像一覧をリロード
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
            fetch(`${apiUrl}/api/gallery/images?date=${date}`)
              .then(r => r.json())
              .then(data => setImages(data))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
