'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { fetchImagesAsFiles, shareFiles, downloadFilesAsZip, isShareSupported } from '@/lib/download-images';
import type { DownloadableImage } from '@/lib/download-images';

type Run = {
  id: string;
  triggered_by: string;
  status: string;
  total_imported: number;
  total_prepared: number;
  total_image_ng: number;
  total_untagged: number;
  total_price_missing: number;
  total_pages: number;
  progress_current: number;
  progress_total: number;
  progress_message: string | null;
  started_at: string;
  import_done_at: string | null;
  prepare_done_at: string | null;
  spectre_done_at: string | null;
  health_check_done_at: string | null;
  plan_done_at: string | null;
  generate_done_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

type DetailCard = {
  id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  price_high?: number | null;
  image_url?: string | null;
  alt_image_url?: string | null;
  image_status?: string | null;
  source?: string;
  // UI-only state
  newUrl?: string;
  fixing?: boolean;
  fixResult?: 'fallback' | 'dead' | null;
  previewUrl?: string | null;
};

type ExcludedCard = {
  id: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
};

type ExcludedCards = {
  untagged: ExcludedCard[];
  price_missing: ExcludedCard[];
  image_ng: ExcludedCard[];
};

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-[#f3faf0] text-[#2d5a2f] border-[#bfd4b8]',
  running: 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse',
  failed: 'bg-[#fff0ec] text-[#8d3a22] border-[#e3b0a2]',
};

const PHASES = [
  { key: 'import_done_at', label: 'インポート' },
  { key: 'prepare_done_at', label: '準備' },
  { key: 'spectre_done_at', label: 'Spectre' },
  { key: 'health_check_done_at', label: 'チェック' },
  { key: 'plan_done_at', label: 'プラン' },
  { key: 'generate_done_at', label: '画像生成' },
] as const;

function formatDate(iso: string | null) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

type Toast = {
  id: string;
  type: 'success' | 'warning';
  message: string;
  details?: string[];
};

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<{ runId: string; type: 'untagged' | 'image' } | null>(null);
  const [detailCards, setDetailCards] = useState<DetailCard[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [generateConfirm, setGenerateConfirm] = useState<ExcludedCards | null>(null);
  const [generateConfirmChecked, setGenerateConfirmChecked] = useState(false);
  const [generateConfirmLoading, setGenerateConfirmLoading] = useState(false);

  // モーダル表示中に背景スクロール防止
  useEffect(() => {
    if (generateConfirm) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [generateConfirm]);
  const [downloadingRunId, setDownloadingRunId] = useState<string | null>(null);
  const [dlProgress, setDlProgress] = useState({ current: 0, total: 0 });
  const [readyFiles, setReadyFiles] = useState<File[] | null>(null);
  const [readyZipName, setReadyZipName] = useState('');
  const runsRef = useRef(runs);
  runsRef.current = runs;
  // 前回fetchで running だった run ID を記録
  const prevRunningRef = useRef<Set<string>>(new Set());
  // 既にトースト表示済みの run ID（重複防止）
  const toastedRef = useRef<Set<string>>(new Set());

  function addToast(toast: Omit<Toast, 'id'>) {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 15000);
  }

  function dismissToast(id: string) {
    setToasts(prev => prev.filter(t => t.id !== id));
  }

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/runs`);
      if (res.ok) {
        const newRuns: Run[] = await res.json();
        const prev = prevRunningRef.current;

        // 前回 running だったrunが completed/failed に変わったらトースト表示
        for (const run of newRuns) {
          if (!prev.has(run.id)) continue;
          if (toastedRef.current.has(run.id)) continue;
          if (run.status === 'completed') {
            toastedRef.current.add(run.id);
            const issues: string[] = [];
            if (run.total_untagged > 0) issues.push(`タグ未設定: ${run.total_untagged}件`);
            if (run.total_price_missing > 0) issues.push(`価格未記入: ${run.total_price_missing}件`);
            if (run.total_image_ng > 0) issues.push(`画像NG: ${run.total_image_ng}件`);
            if (issues.length === 0) {
              addToast({ type: 'success', message: '同期が完了しました！タグ未設定・画像NGはありませんでした。' });
            } else {
              addToast({ type: 'warning', message: '同期が完了しました。確認が必要な項目があります。', details: issues });
            }
          } else if (run.status === 'failed') {
            toastedRef.current.add(run.id);
            addToast({ type: 'warning', message: `ジョブが失敗しました: ${run.error_message || '不明なエラー'}` });
          }
        }

        // 現在 running な ID を記録
        prevRunningRef.current = new Set(newRuns.filter(r => r.status === 'running').map(r => r.id));
        setRuns(newRuns);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  // 動的ポーリング: running中は2秒、それ以外は10秒
  useEffect(() => {
    fetchRuns();
    const id = setInterval(() => {
      fetchRuns();
    }, runsRef.current.some(r => r.status === 'running') ? 2000 : 10000);
    return () => clearInterval(id);
  }, [fetchRuns]);

  // running 状態が変わったらインターバルを再設定
  const runningRun = runs.find(r => r.status === 'running');
  const hasRunning = !!runningRun;
  const hasCompletedSync = runs.some(r => r.status === 'completed' && r.plan_done_at && !r.generate_done_at);
  useEffect(() => {
    const id = setInterval(fetchRuns, hasRunning ? 2000 : 10000);
    return () => clearInterval(id);
  }, [hasRunning, fetchRuns]);

  async function triggerJob(jobName: string) {
    setTriggering(jobName);
    try {
      await fetch(`${API_URL}/api/jobs/${jobName}`, { method: 'POST' });
      setTimeout(fetchRuns, 1000);
    } catch {
      // ignore
    }
    setTriggering(null);
  }

  async function handleGenerateClick() {
    // 最新の completed run を取得して除外カード一覧を確認
    const latestCompleted = runs.find(r => r.status === 'completed');
    if (!latestCompleted) {
      addToast({ type: 'warning', message: '同期が完了したRunがありません。先に同期を実行してください。' });
      return;
    }
    setGenerateConfirmLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/runs/${latestCompleted.id}/excluded-cards`);
      if (!res.ok) throw new Error('除外カード取得失敗');
      const excluded: ExcludedCards = await res.json();
      const total = excluded.untagged.length + excluded.price_missing.length + excluded.image_ng.length;
      if (total === 0) {
        // 除外カードなし → そのまま生成
        triggerJob('generate');
      } else {
        // 除外カードあり → 確認モーダル表示
        setGenerateConfirm(excluded);
        setGenerateConfirmChecked(false);
      }
    } catch {
      addToast({ type: 'warning', message: '除外カード確認に失敗しました。' });
    }
    setGenerateConfirmLoading(false);
  }

  function updateDetailCard(cardId: string, updates: Partial<DetailCard>) {
    setDetailCards(prev => prev.map(c => c.id === cardId ? { ...c, ...updates } : c));
  }

  async function fixImage(runId: string, card: DetailCard) {
    if (!card.newUrl?.trim()) return;
    updateDetailCard(card.id, { fixing: true, fixResult: null });
    try {
      const res = await fetch(`${API_URL}/api/runs/${runId}/fix-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepared_card_id: card.id, new_url: card.newUrl.trim() }),
      });
      const result = await res.json();
      if (result.success) {
        updateDetailCard(card.id, { fixing: false, fixResult: 'fallback', image_status: 'fallback', alt_image_url: card.newUrl!.trim(), previewUrl: card.newUrl!.trim() });
        // run の total_image_ng も減るので再取得
        fetchRuns();
      } else {
        updateDetailCard(card.id, { fixing: false, fixResult: 'dead' });
      }
    } catch {
      updateDetailCard(card.id, { fixing: false, fixResult: 'dead' });
    }
  }

  async function toggleDetail(runId: string, type: 'untagged' | 'image') {
    if (expandedDetail?.runId === runId && expandedDetail?.type === type) {
      setExpandedDetail(null);
      setDetailCards([]);
      return;
    }
    setExpandedDetail({ runId, type });
    setDetailLoading(true);
    try {
      const endpoint = type === 'untagged' ? 'untagged-cards' : 'image-issues';
      const res = await fetch(`${API_URL}/api/runs/${runId}/${endpoint}`);
      if (res.ok) setDetailCards(await res.json());
    } catch {
      setDetailCards([]);
    }
    setDetailLoading(false);
  }

  async function handleRunDownload(run: Run) {
    const dateStr = new Date(run.started_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    setDownloadingRunId(run.id);
    setDlProgress({ current: 0, total: 0 });
    try {
      const res = await fetch(`${API_URL}/api/gallery/images?date=${dateStr}`);
      if (!res.ok) return;
      const pages: { id: string; franchise: string; page_label: string | null; page_index: number; image_url: string | null; run_id: string }[] = await res.json();
      const runPages = pages.filter(p => p.run_id === run.id && p.image_url);
      const list: DownloadableImage[] = runPages.map(p => ({
        image_url: p.image_url!,
        filename: `${p.franchise}_${p.page_label || `page-${p.page_index}`}.png`,
      }));
      if (list.length === 0) return;
      setDlProgress({ current: 0, total: list.length });
      const files = await fetchImagesAsFiles(list, (cur, total) => setDlProgress({ current: cur, total }));
      if (files.length === 0) return;
      if (isShareSupported()) {
        setReadyFiles(files);
        setReadyZipName(`haraka_${dateStr}.zip`);
        return; // overlayで共有/ZIPボタン表示
      }
      await downloadFilesAsZip(files, `haraka_${dateStr}.zip`);
    } finally {
      if (!readyFiles) setDownloadingRunId(null);
    }
  }

  async function handleRunShare() {
    if (!readyFiles) return;
    const shared = await shareFiles(readyFiles);
    if (!shared) await downloadFilesAsZip(readyFiles, readyZipName);
    setReadyFiles(null);
    setDownloadingRunId(null);
  }

  async function handleRunZip() {
    if (!readyFiles) return;
    await downloadFilesAsZip(readyFiles, readyZipName);
    setReadyFiles(null);
    setDownloadingRunId(null);
  }

  function handleRunDlCancel() {
    setReadyFiles(null);
    setDownloadingRunId(null);
  }

  return (
    <div>
      {/* Download progress / share overlay */}
      {downloadingRunId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card-bg border border-border-card rounded-2xl shadow-2xl p-8 w-80">
            {readyFiles ? (
              <>
                <p className="text-sm font-semibold text-text-primary mb-1">準備完了！</p>
                <p className="text-xs text-text-secondary mb-4">{readyFiles.length}枚の画像</p>
                <div className="space-y-2">
                  <button
                    onClick={handleRunShare}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold bg-text-primary text-white hover:opacity-90 transition-opacity"
                  >
                    共有する（写真に保存）
                  </button>
                  <button
                    onClick={handleRunZip}
                    className="w-full py-2.5 rounded-xl text-sm font-medium border border-border-card text-text-secondary hover:bg-warm-100 transition-colors"
                  >
                    ZIPでダウンロード
                  </button>
                  <button
                    onClick={handleRunDlCancel}
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

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-24 right-6 z-50 flex flex-col gap-3 max-w-md">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`rounded-xl border p-4 shadow-lg animate-in slide-in-from-right backdrop-blur-sm ${
                toast.type === 'success'
                  ? 'bg-[#f3faf0]/95 border-[#bfd4b8] text-[#2d5a2f]'
                  : 'bg-amber-50/95 border-amber-200 text-amber-800'
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-lg flex-shrink-0">{toast.type === 'success' ? '✅' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{toast.message}</p>
                  {toast.details && toast.details.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {toast.details.map((d, i) => (
                        <li key={i} className="text-xs opacity-80">・{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <button onClick={() => dismissToast(toast.id)} className="text-sm opacity-50 hover:opacity-100 flex-shrink-0">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Generate confirmation modal */}
      {generateConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card-bg border border-border-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col mx-4">
            <div className="p-6 border-b border-border-card">
              <h2 className="text-lg font-bold text-text-primary">画像生成の確認</h2>
              <p className="text-sm text-text-secondary mt-1">
                以下のカードはデータ不足のため生成されません。よろしいですか？
              </p>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              {generateConfirm.untagged.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-amber-700 mb-2">
                    タグ未設定（{generateConfirm.untagged.length}件）
                  </h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {generateConfirm.untagged.map(c => (
                      <div key={c.id} className="text-xs text-text-secondary flex gap-2 py-0.5">
                        <span className="text-text-primary font-medium truncate flex-1">{c.card_name}</span>
                        <span className="text-warm-400 shrink-0">{c.franchise}</span>
                        <span className="shrink-0">{c.grade}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {generateConfirm.price_missing.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-red-700 mb-2">
                    価格未記入（{generateConfirm.price_missing.length}件）
                  </h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {generateConfirm.price_missing.map(c => (
                      <div key={c.id} className="text-xs text-text-secondary flex gap-2 py-0.5">
                        <span className="text-text-primary font-medium truncate flex-1">{c.card_name}</span>
                        <span className="text-warm-400 shrink-0">{c.tag}</span>
                        <span className="shrink-0">
                          高:{c.price_high != null ? `¥${c.price_high.toLocaleString()}` : <span className="text-red-500">未記入</span>}
                          {' '}
                          低:{c.price_low != null ? `¥${c.price_low.toLocaleString()}` : <span className="text-red-500">未記入</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {generateConfirm.image_ng.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-orange-700 mb-2">
                    画像NG（{generateConfirm.image_ng.length}件）
                  </h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {generateConfirm.image_ng.map(c => (
                      <div key={c.id} className="text-xs text-text-secondary flex gap-2 py-0.5">
                        <span className="text-text-primary font-medium truncate flex-1">{c.card_name}</span>
                        <span className="text-warm-400 shrink-0">{c.tag}</span>
                        <span className="shrink-0">{c.grade}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-border-card space-y-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={generateConfirmChecked}
                  onChange={e => setGenerateConfirmChecked(e.target.checked)}
                  className="w-4 h-4 rounded border-warm-300 text-text-primary focus:ring-warm-500"
                />
                <span className="text-sm text-text-secondary">
                  上記のカードが除外されることを確認しました
                </span>
              </label>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setGenerateConfirm(null)}
                  className="px-4 py-2 rounded-full text-sm border border-border-card text-text-secondary hover:bg-warm-50 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => {
                    setGenerateConfirm(null);
                    triggerJob('generate');
                  }}
                  disabled={!generateConfirmChecked}
                  className={`px-5 py-2 rounded-full text-sm font-semibold transition-all ${
                    generateConfirmChecked
                      ? 'bg-text-primary text-white hover:bg-warm-800 active:scale-95'
                      : 'bg-text-primary/30 text-white/50 cursor-not-allowed'
                  }`}
                >
                  生成する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 sm:mb-14">
        <div>
          <h1 className="page-title text-2xl sm:text-4xl text-text-primary whitespace-nowrap">実行履歴</h1>
        </div>
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {hasRunning ? (
            <>
              <div className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap bg-blue-600 text-white flex items-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {runningRun?.generate_done_at === null && runningRun?.plan_done_at ? '画像生成中...' : '同期実行中...'}
              </div>
              <button
                onClick={async () => {
                  if (!runningRun || !confirm('実行中のジョブを強制停止しますか？')) return;
                  try {
                    const res = await fetch(`${API_URL}/api/runs/${runningRun.id}/reset`, { method: 'POST' });
                    if (res.ok) {
                      addToast({ type: 'success', message: 'ジョブを強制停止しました。' });
                      fetchRuns();
                    } else {
                      const err = await res.json();
                      addToast({ type: 'warning', message: `停止失敗: ${err.error}` });
                    }
                  } catch {
                    addToast({ type: 'warning', message: '停止リクエストに失敗しました。' });
                  }
                }}
                className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap border border-red-300 text-red-700 bg-red-50 hover:bg-red-100 transition-colors"
              >
                ⏹ 強制停止
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => triggerJob('sync')}
                disabled={triggering !== null}
                className={`px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap transition-all duration-100 select-none ${
                  triggering === 'sync'
                    ? 'bg-blue-600 text-white scale-90 shadow-inner'
                    : triggering !== null
                      ? 'bg-text-primary/40 text-white/70 cursor-not-allowed'
                      : 'bg-text-primary text-white hover:bg-warm-800 active:scale-90 active:bg-warm-900 active:shadow-[inset_0_2px_8px_rgba(0,0,0,0.3)]'
                }`}
              >
                {triggering === 'sync' ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    起動中...
                  </span>
                ) : '同期実行 →'}
              </button>
              <button
                onClick={() => handleGenerateClick()}
                disabled={triggering !== null || generateConfirmLoading || !hasCompletedSync}
                className={`px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap transition-all duration-100 select-none ${
                  triggering === 'generate' || generateConfirmLoading
                    ? 'bg-blue-600 text-white scale-90 shadow-inner'
                    : triggering !== null || !hasCompletedSync
                      ? 'bg-text-primary/40 text-white/70 cursor-not-allowed'
                      : 'bg-text-primary text-white hover:bg-warm-800 active:scale-90 active:bg-warm-900 active:shadow-[inset_0_2px_8px_rgba(0,0,0,0.3)]'
                }`}
                title={!hasCompletedSync ? '先に同期を実行してください' : undefined}
              >
                {triggering === 'generate' ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    起動中...
                  </span>
                ) : generateConfirmLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    確認中...
                  </span>
                ) : !hasCompletedSync ? '画像生成（同期が必要）' : '画像生成 →'}
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-text-secondary">読み込み中...</p>
      ) : runs.length === 0 ? (
        <p className="text-text-secondary">実行履歴がありません</p>
      ) : (
        <div className="space-y-6">
          {runs.map((run) => (
            <div key={run.id} className="bg-card-bg border border-border-card rounded-2xl p-4 sm:p-8">
              <div className="flex items-start justify-between mb-5">
                <div className="flex items-center gap-3">
                  <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold border ${STATUS_STYLES[run.status] || 'bg-warm-100 text-warm-500'}`}>
                    {run.status}
                  </span>
                  <span className="text-sm text-text-secondary">{run.triggered_by}</span>
                </div>
                <p className="text-base text-text-secondary">{formatDate(run.started_at)}</p>
              </div>

              {/* Phase progress */}
              <div className="grid grid-cols-3 sm:flex gap-1.5 mb-5">
                {PHASES.map((phase) => {
                  const done = !!(run as Record<string, unknown>)[phase.key];
                  return (
                    <div
                      key={phase.key}
                      className={`sm:flex-1 rounded-lg px-2 py-2 text-xs text-center whitespace-nowrap transition-colors ${
                        done
                          ? 'bg-[#f3faf0] text-[#2d5a2f] border border-[#bfd4b8]'
                          : run.status === 'running'
                          ? 'bg-page-bg text-text-secondary border border-border-card'
                          : 'bg-page-bg/50 text-border-card border border-[#e8dccf]'
                      }`}
                    >
                      {done ? '✓ ' : ''}{phase.label}
                    </div>
                  );
                })}
              </div>

              {/* Progress bar */}
              {run.status === 'running' && run.progress_total > 0 && (
                <div className="mb-5">
                  <div className="flex justify-between text-xs text-text-secondary mb-1.5">
                    <span>{run.progress_message || '処理中...'}</span>
                    <span>{run.progress_current}/{run.progress_total}</span>
                  </div>
                  <div className="w-full bg-warm-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-text-primary h-2 rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${Math.min(100, Math.round((run.progress_current / run.progress_total) * 100))}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Running message (no progress data yet) */}
              {run.status === 'running' && run.progress_total === 0 && (
                <div className="mb-5">
                  <div className="text-xs text-text-secondary mb-1.5">
                    {run.progress_message || '起動中...'}
                  </div>
                  <div className="w-full bg-warm-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-text-primary/40 h-2 rounded-full w-1/3 animate-pulse" />
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-base text-text-secondary">
                <span>取込: <span className="font-bold text-lg text-text-primary">{run.total_imported}</span></span>
                <span>準備: <span className="font-bold text-lg text-text-primary">{run.total_prepared}</span></span>
                {run.total_untagged > 0 && (
                  <span className="text-amber-700">タグなし: <span className="font-bold text-lg">{run.total_untagged}</span></span>
                )}
                {run.total_price_missing > 0 && (
                  <span className="text-red-700">価格未記入: <span className="font-bold text-lg">{run.total_price_missing}</span></span>
                )}
                {run.total_image_ng > 0 && (
                  <span className="text-red-700">画像NG: <span className="font-bold text-lg">{run.total_image_ng}</span></span>
                )}
                <span>ページ: <span className="font-bold text-lg text-text-primary">{run.total_pages}</span></span>
              </div>

              {/* Gallery link for completed generate runs */}
              {run.status === 'completed' && (
                <div className="mt-4 flex flex-wrap gap-3">
                  {run.generate_done_at && (
                    <>
                      <Link
                        href={`/gallery/${new Date(run.started_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })}`}
                        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-border-card text-text-primary hover:bg-warm-100 transition-colors"
                      >
                        ギャラリーを見る →
                      </Link>
                      <button
                        onClick={() => handleRunDownload(run)}
                        disabled={downloadingRunId !== null}
                        className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-border-card text-text-primary hover:bg-warm-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        画像DL
                      </button>
                    </>
                  )}
                  {run.import_done_at && (
                    <a
                      href={`${API_URL}/api/runs/${run.id}/kecak-csv`}
                      className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-full border border-border-card text-text-primary hover:bg-warm-100 transition-colors"
                      download
                    >
                      KECAK CSV
                    </a>
                  )}
                </div>
              )}

              {/* Untagged / Image NG alerts */}
              {run.status === 'completed' && (run.total_untagged > 0 || run.total_image_ng > 0) && (
                <div className="mt-4 flex gap-3">
                  {run.total_untagged > 0 && (
                    <button
                      onClick={() => toggleDetail(run.id, 'untagged')}
                      className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                        expandedDetail?.runId === run.id && expandedDetail?.type === 'untagged'
                          ? 'bg-amber-100 text-amber-800 border-amber-300'
                          : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      タグなし {run.total_untagged}件 {expandedDetail?.runId === run.id && expandedDetail?.type === 'untagged' ? '▲' : '▼'}
                    </button>
                  )}
                  {run.total_image_ng > 0 && (
                    <button
                      onClick={() => toggleDetail(run.id, 'image')}
                      className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                        expandedDetail?.runId === run.id && expandedDetail?.type === 'image'
                          ? 'bg-red-100 text-red-800 border-red-300'
                          : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                      }`}
                    >
                      画像NG {run.total_image_ng}件 {expandedDetail?.runId === run.id && expandedDetail?.type === 'image' ? '▲' : '▼'}
                    </button>
                  )}
                </div>
              )}

              {/* Detail accordion */}
              {expandedDetail?.runId === run.id && (
                <div className="mt-4 bg-page-bg rounded-xl border border-border-card p-4 max-h-80 overflow-y-auto">
                  {detailLoading ? (
                    <p className="text-sm text-text-secondary">読み込み中...</p>
                  ) : detailCards.length === 0 ? (
                    <p className="text-sm text-text-secondary">該当なし</p>
                  ) : (
                    <div className="space-y-3">
                      {expandedDetail.type === 'untagged' && (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-text-secondary border-b border-border-card">
                              <th className="pb-2 pr-3">フランチャイズ</th>
                              <th className="pb-2 pr-3">カード名</th>
                              <th className="pb-2 pr-3">種別</th>
                              <th className="pb-2 pr-3">No.</th>
                              <th className="pb-2 text-right">価格</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detailCards.map((card) => (
                              <tr key={card.id} className="border-b border-border-card/50 last:border-0">
                                <td className="py-1.5 pr-3 text-text-secondary">{card.franchise}</td>
                                <td className="py-1.5 pr-3 text-text-primary font-medium">{card.card_name}</td>
                                <td className="py-1.5 pr-3 text-text-secondary">{card.grade || '-'}</td>
                                <td className="py-1.5 pr-3 text-text-secondary">{card.list_no || '-'}</td>
                                <td className="py-1.5 text-right text-text-primary">
                                  {card.price_high ? `¥${card.price_high.toLocaleString()}` : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {expandedDetail.type === 'image' && detailCards.map((card) => (
                        <div key={card.id} className={`rounded-xl border p-4 transition-colors ${card.fixResult === 'fallback' ? 'bg-green-50 border-green-200' : 'bg-white border-border-card'}`}>
                          <div className="flex gap-4">
                            {/* サムネイルプレビュー */}
                            <div className="flex-shrink-0 w-20 h-28 rounded-lg border border-border-card bg-warm-100 overflow-hidden flex items-center justify-center">
                              {(card.previewUrl || card.alt_image_url || card.image_url) ? (
                                <img
                                  src={card.previewUrl || card.alt_image_url || card.image_url || ''}
                                  alt={card.card_name}
                                  className="w-full h-full object-contain"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                    (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                                  }}
                                  onLoad={(e) => {
                                    (e.target as HTMLImageElement).style.display = '';
                                    const sib = (e.target as HTMLImageElement).nextElementSibling;
                                    if (sib) sib.classList.add('hidden');
                                  }}
                                />
                              ) : null}
                              <span className={`text-xs text-text-secondary ${(card.previewUrl || card.alt_image_url || card.image_url) ? 'hidden' : ''}`}>No img</span>
                            </div>
                            {/* カード情報 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium text-text-primary">{card.card_name}</span>
                                {card.fixResult === 'fallback' || card.image_status === 'fallback' ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">✓ 修正済み</span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">dead</span>
                                )}
                              </div>
                              <div className="flex gap-3 text-xs text-text-secondary mb-2">
                                <span>{card.franchise}</span>
                                <span>{card.grade || '-'}</span>
                                <span>{card.list_no || '-'}</span>
                              </div>
                              {/* URL入力 + チェック */}
                              {card.fixResult !== 'fallback' && card.image_status !== 'fallback' ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    placeholder="代替画像URLを入力"
                                    value={card.newUrl || ''}
                                    onChange={(e) => updateDetailCard(card.id, { newUrl: e.target.value, previewUrl: e.target.value || null, fixResult: null })}
                                    className="flex-1 px-3 py-1.5 text-xs border border-border-card rounded-lg bg-white focus:outline-none focus:border-text-primary"
                                  />
                                  <button
                                    onClick={() => fixImage(run.id, card)}
                                    disabled={card.fixing || !card.newUrl?.trim()}
                                    className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg border transition-colors bg-text-primary text-white hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    {card.fixing ? '確認中...' : '保存'}
                                  </button>
                                  {card.fixResult === 'dead' && (
                                    <span className="text-xs text-red-500 flex-shrink-0">画像が読み込めません</span>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-green-600 truncate">
                                  {card.alt_image_url || card.previewUrl}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}


              {run.error_message && (
                <p className="mt-4 text-sm text-[#8d3a22] bg-[#fff0ec] border border-[#e3b0a2] p-3 rounded-xl">{run.error_message}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
