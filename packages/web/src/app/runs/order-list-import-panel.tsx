'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FRANCHISES, FRANCHISE_JA, KECAK_SHEET_MAP } from '@haraka/shared';
import { OrderListMatchReview } from './order-list-match-review';
import {
  clearOrderListSyncRequestId,
  getOrCreateOrderListSyncRequestId,
  isLaunchPendingConfirmation,
  resetFileInputValue,
  selectionProgress,
  shouldResyncOrderListImport,
  type OrderListExclusionSelection,
  type OrderListMappingSelection,
  type OrderListNewCardSelection,
} from './order-list-match-review-state';

export type OrderListFranchiseSummary = {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
  excluded?: number;
};

export type OrderListImportIssue = {
  sheet?: string;
  row?: number;
  code?: string;
  message: string;
};

export type OrderListImportResult = {
  import: {
    id: string;
    filename: string;
    status: string;
    imported_at: string;
    total_rows: number;
    structural_valid?: boolean;
    persistence_complete?: boolean;
    applied_summary?: unknown;
  };
  summary: OrderListFranchiseSummary & {
    by_franchise: Record<string, OrderListFranchiseSummary>;
  };
  issues: OrderListImportIssue[];
};

export type OrderListConfirmResult = {
  import_id: string;
  status: 'confirmed' | string;
  sync_started: boolean;
  launch_pending?: boolean;
  run_id?: string;
  run_status?: string;
  request_id?: string;
  created?: number;
  reused?: number;
  resolved?: number;
  unselected?: number;
  invalid?: number;
  excluded?: number;
  job?: { pid?: number; operation?: string; execution?: string | null };
};

export type OrderListImportPanelProps = {
  apiBaseUrl: string;
  disabled?: boolean;
  onTriggered?: (result: OrderListConfirmResult) => void | Promise<void>;
};

type PendingAction = 'upload' | 'confirm' | null;
type PanelView = 'upload' | 'review';
type ApiErrorPayload = { error?: string | { message?: string }; message?: string };

const FRANCHISE_ORDER = FRANCHISES.map((franchise) => franchise.toUpperCase());

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload as ApiErrorPayload;
  if (typeof value.error === 'string' && value.error.trim()) return value.error;
  if (value.error && typeof value.error === 'object' && value.error.message) return value.error.message;
  return value.message || fallback;
}

function isImportResult(payload: unknown): payload is OrderListImportResult {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<OrderListImportResult>;
  return Boolean(
    value.import?.id
    && value.import.filename
    && value.summary
    && typeof value.summary.matched === 'number'
    && value.summary.by_franchise
    && Array.isArray(value.issues),
  );
}

function isConfirmResult(payload: unknown): payload is OrderListConfirmResult {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<OrderListConfirmResult>;
  return Boolean(value.import_id && value.status && typeof value.sync_started === 'boolean');
}

function uploadWorkbook(
  endpoint: string,
  file: File,
  onProgress: (value: number) => void,
  onRequest: (request: XMLHttpRequest | null) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const body = new FormData();
    body.append('file', file);
    onRequest(request);
    request.open('POST', endpoint);
    request.setRequestHeader('Accept', 'application/json');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    });
    request.addEventListener('load', () => {
      onRequest(null);
      const payload = parseJson(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(payload);
      } else {
        reject(new Error(errorMessage(payload, `読み込みに失敗しました（${request.status}）`)));
      }
    });
    request.addEventListener('error', () => {
      onRequest(null);
      reject(new Error('サーバーに接続できませんでした。通信状態を確認してください。'));
    });
    request.addEventListener('abort', () => {
      onRequest(null);
      reject(new Error('読み込みを中止しました。'));
    });
    request.send(body);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function franchiseLabel(franchise: string): string {
  const normalized = franchise.trim().toUpperCase();
  const key = FRANCHISES.find((candidate) => candidate.toUpperCase() === normalized);
  if (key) return FRANCHISE_JA[key];
  return franchise;
}

function franchiseSortOrder(franchise: string): number {
  const index = FRANCHISE_ORDER.indexOf(franchise.trim().toUpperCase());
  return index < 0 ? FRANCHISE_ORDER.length : index;
}

function syncRequestPayloadSignature(
  mappings: OrderListMappingSelection[],
  newCards: OrderListNewCardSelection[],
  exclusions: OrderListExclusionSelection[],
  allowUnresolved: boolean,
): string {
  return JSON.stringify({
    mappings,
    new_cards: newCards,
    exclusions,
    allow_unresolved: allowUnresolved,
  });
}

export default function OrderListImportPanel({
  apiBaseUrl,
  disabled = false,
  onTriggered,
}: OrderListImportPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>('upload');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<OrderListImportResult | null>(null);
  const [confirmed, setConfirmed] = useState<OrderListConfirmResult | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<OrderListConfirmResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const inFlightRef = useRef(false);
  const fallbackSyncRequestIdsRef = useRef<Record<string, {
    requestId: string;
    payloadSignature: string;
  }>>({});
  const inputId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const busy = pendingAction !== null;
  const endpointBase = apiBaseUrl.replace(/\/$/, '');
  const canConfirm = Boolean(review
    && ['parsed', 'failed', 'confirmed', 'applied'].includes(review.import.status)
    && review.import.structural_valid !== false
    && review.import.persistence_complete === true
    && review.summary.matched > 0);
  const unresolved = review
    ? review.summary.ambiguous + review.summary.unmatched + review.summary.invalid
    : 0;
  const franchiseRows = useMemo(() => Object.entries(review?.summary.by_franchise ?? {})
    .sort(([a], [b]) => franchiseSortOrder(a) - franchiseSortOrder(b) || a.localeCompare(b, 'ja')), [review]);

  const reset = useCallback(() => {
    setPanelView('upload');
    setSelectedFile(null);
    setUploadProgress(0);
    setError(null);
    setReview(null);
    setConfirmed(null);
    setPendingConfirmation(null);
    resetFileInputValue(inputRef.current);
  }, []);

  useEffect(() => () => requestRef.current?.abort(), []);


  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !inFlightRef.current) {
        setIsOpen(false);
        reset();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => fileButtonRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, reset]);

  function startNewImport() {
    reset();
    setPanelView('upload');
  }

  function close() {
    if (inFlightRef.current) return;
    setIsOpen(false);
    reset();
  }

  function openFileChooser() {
    if (inFlightRef.current) return;
    resetFileInputValue(inputRef.current);
    inputRef.current?.click();
  }

  function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    if (inFlightRef.current) return;
    const file = event.target.files?.[0] ?? null;
    setError(null);
    setReview(null);
    setConfirmed(null);
    setPendingConfirmation(null);
    setUploadProgress(0);
    if (!file) return setSelectedFile(null);
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setSelectedFile(null);
      event.target.value = '';
      return setError('Excel（.xlsx）ファイルを選択してください。');
    }
    if (file.size === 0) {
      setSelectedFile(null);
      event.target.value = '';
      return setError('空のファイルは読み込めません。');
    }
    if (file.size > 15 * 1024 * 1024) {
      setSelectedFile(null);
      event.target.value = '';
      return setError('ファイルサイズは15MB以下にしてください。');
    }
    setSelectedFile(file);
  }


  async function upload() {
    if (!selectedFile || inFlightRef.current) return;

    inFlightRef.current = true;
    setPendingAction('upload');
    setUploadProgress(0);
    setError(null);
    setReview(null);
    setConfirmed(null);
    setPendingConfirmation(null);
    try {
      const payload = await uploadWorkbook(
        `${endpointBase}/api/order-list/imports`,
        selectedFile,
        setUploadProgress,
        (request) => { requestRef.current = request; },
      );
      if (!isImportResult(payload)) throw new Error('取込結果の形式が正しくありません。');
      setReview(payload);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '読み込みに失敗しました。');
    } finally {
      inFlightRef.current = false;
      setPendingAction(null);
      requestRef.current = null;
    }
  }

  function getResyncRequestId(importId: string, payloadSignature: string): string {
    const fallback = fallbackSyncRequestIdsRef.current[importId];
    if (fallback?.payloadSignature === payloadSignature) return fallback.requestId;
    try {
      const requestId = getOrCreateOrderListSyncRequestId(
        window.localStorage, importId, payloadSignature, () => window.crypto.randomUUID(),
      );
      fallbackSyncRequestIdsRef.current[importId] = { requestId, payloadSignature };
      return requestId;
    } catch {
      const requestId = window.crypto.randomUUID();
      fallbackSyncRequestIdsRef.current[importId] = { requestId, payloadSignature };
      return requestId;
    }
  }

  function clearResyncRequestId(importId: string): void {
    delete fallbackSyncRequestIdsRef.current[importId];
    try {
      clearOrderListSyncRequestId(window.localStorage, importId);
    } catch {
      // localStorage can be unavailable in hardened browsers; the in-memory key is already cleared.
    }
  }

  async function requestImportConfirmation(
    importId: string,
    mappings: OrderListMappingSelection[] = [],
    newCards: OrderListNewCardSelection[] = [],
    exclusions: OrderListExclusionSelection[] = [],
    allowUnresolved = false,
    resync = false,
    requestId?: string,
  ): Promise<OrderListConfirmResult> {
    if (resync && !requestId) throw new Error('再同期の操作IDを生成できませんでした。');
    if (inFlightRef.current) throw new Error('別の処理が完了するまでお待ちください。');
    inFlightRef.current = true;
    setPendingAction('confirm');
    try {
      const response = await fetch(
        `${endpointBase}/api/order-list/imports/${encodeURIComponent(importId)}/${resync ? 'resync' : 'confirm'}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mappings,
            new_cards: newCards,
            exclusions,
            allow_unresolved: allowUnresolved,
            ...(resync ? { request_id: requestId } : {}),
          }),
        },
      );
      const payload = parseJson(await response.text());
      if (!response.ok) throw new Error(errorMessage(payload, `反映の開始に失敗しました（${response.status}）`));
      if (!isConfirmResult(payload)) throw new Error('確定結果の形式が正しくありません。');
      return payload;
    } finally {
      inFlightRef.current = false;
      setPendingAction(null);
    }
  }

  function completeConfirmation(result: OrderListConfirmResult): void {
    if (isLaunchPendingConfirmation(result)) {
      setConfirmed(null);
      setPendingConfirmation(result);
      setPanelView('review');
      void refreshImportReview(result.import_id);
    } else {
      setPendingConfirmation(null);
      setConfirmed(result);
    }
    void Promise.resolve(onTriggered?.(result)).catch(() => undefined);
  }

  async function confirmImport() {
    if (!review || !canConfirm || inFlightRef.current) return;
    const progress = selectionProgress(review.summary, {});
    const resync = shouldResyncOrderListImport({
      status: review.import.status,
      appliedSummary: review.import.applied_summary,
    });
    const allowUnresolved = progress.unselected > 0;
    const payloadSignature = syncRequestPayloadSignature([], [], [], allowUnresolved);
    const requestId = resync
      ? getResyncRequestId(review.import.id, payloadSignature)
      : undefined;
    setError(null);
    try {
      const result = await requestImportConfirmation(
        review.import.id, [], [], [], allowUnresolved, resync, requestId,
      );
      if (resync && (result.status === 'failed' || result.run_status === 'failed')) {
        clearResyncRequestId(review.import.id);
        throw new Error('前回の同期は失敗しています。もう一度押すと新しい同期として再試行します。');
      }
      completeConfirmation(result);
      if (resync && !isLaunchPendingConfirmation(result)) clearResyncRequestId(review.import.id);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '反映の開始に失敗しました。');
    }
  }

  async function confirmImportFromHistory(
    importId: string,
    mappings: OrderListMappingSelection[],
    newCards: OrderListNewCardSelection[],
    exclusions: OrderListExclusionSelection[],
    allowUnresolved: boolean,
  ): Promise<OrderListConfirmResult> {
    const result = await requestImportConfirmation(importId, mappings, newCards, exclusions, allowUnresolved);
    completeConfirmation(result);
    return result;
  }

  async function resyncImportFromHistory(
    importId: string,
    mappings: OrderListMappingSelection[],
    newCards: OrderListNewCardSelection[],
    exclusions: OrderListExclusionSelection[],
    allowUnresolved: boolean,
  ): Promise<OrderListConfirmResult> {
    const payloadSignature = syncRequestPayloadSignature(
      mappings, newCards, exclusions, allowUnresolved,
    );
    const requestId = getResyncRequestId(importId, payloadSignature);
    const result = await requestImportConfirmation(
      importId, mappings, newCards, exclusions, allowUnresolved, true, requestId,
    );
    if (result.status === 'failed' || result.run_status === 'failed') {
      clearResyncRequestId(importId);
      throw new Error('前回の同期は失敗しています。もう一度押すと新しい同期として再試行します。');
    }
    completeConfirmation(result);
    if (!isLaunchPendingConfirmation(result)) clearResyncRequestId(importId);
    return result;
  }

  async function refreshImportReview(importId: string) {
    try {
      const response = await fetch(
        `${endpointBase}/api/order-list/imports/${encodeURIComponent(importId)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) return;
      const payload = parseJson(await response.text());
      if (!isImportResult(payload)) return;
      setReview((current) => current?.import.id === importId ? payload : current);
    } catch {
      // The mapping itself has already succeeded; the latest summary is fetched next time the panel opens.
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { startNewImport(); setIsOpen(true); }}
        disabled={disabled}
        className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-xs sm:text-sm font-semibold whitespace-nowrap transition-all duration-100 select-none bg-text-primary text-white hover:bg-warm-800 active:scale-90 disabled:bg-text-primary/40 disabled:text-white/70 disabled:cursor-not-allowed disabled:active:scale-100"
      >
        オーダーリスト読み込み
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            aria-busy={busy}
            className="bg-card-bg border border-border-card rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
          >
            <header className="flex items-start justify-between gap-4 p-5 sm:p-6 border-b border-border-card">
              <div>
                <h2 id={titleId} className="text-lg sm:text-xl font-bold text-text-primary">オーダーリスト読み込み</h2>
                <p id={descriptionId} className="text-xs sm:text-sm text-text-secondary mt-1">
                  {FRANCHISES.length}商材を含むExcelを読み込み、商品照合の結果を確認してから反映します。
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                aria-label="閉じる"
                className="shrink-0 w-9 h-9 rounded-full border border-border-card text-text-secondary hover:text-text-primary hover:bg-warm-100 disabled:opacity-40"
              >
                ✕
              </button>
            </header>

            <div className="overflow-y-auto flex-1 p-5 sm:p-6 space-y-5">

              {!confirmed && (
                <div className="flex w-full max-w-md rounded-xl border border-border-card bg-page-bg p-1" aria-label="オーダーリスト操作">
                  <button
                    type="button"
                    onClick={startNewImport}
                    disabled={busy}
                    aria-pressed={panelView === 'upload'}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${panelView === 'upload' ? 'bg-card-bg text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    新規読み込み
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPanelView('review')}
                    aria-pressed={panelView === 'review'}
                    className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${panelView === 'review' ? 'bg-card-bg text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                  >
                    未照合を確認
                  </button>
                </div>
              )}
              {pendingConfirmation && !confirmed && (
                <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950" role="status">
                  <p className="font-bold">取込は確定済みで、同期ジョブの開始を確認中です。</p>
                  <p className="mt-1 text-sm leading-relaxed">
                    二重起動を防ぐため待機しています。下の履歴を更新し、開始されていなければ約5分後に「同期を再試行」を押してください。
                  </p>
                  <p className="mt-1 text-xs opacity-80">取込ID: <span className="font-mono">{pendingConfirmation.import_id}</span></p>
                </div>
              )}
              {confirmed ? (
                <div className="rounded-xl border border-[#bfd4b8] bg-[#f3faf0] p-5 text-[#2d5a2f]" role="status">
                  <p className="font-semibold">
                    {confirmed.status === 'applied'
                      ? '同じ同期操作はすでに完了しています。'
                      : confirmed.status === 'processing' || confirmed.run_status === 'running'
                        ? '同期はすでに実行中です。'
                        : confirmed.sync_started
                          ? '読み込みを確定し、同期を開始しました。'
                          : confirmed.launch_pending
                            ? '読み込みは確定済みで、同期の開始を確認中です。'
                            : '読み込みを確定しました。'}
                  </p>
                  {Boolean(confirmed.created || confirmed.reused) && (
                    <p className="text-sm mt-1 opacity-90">
                      新規DB商品 {confirmed.created ?? 0}件
                      {confirmed.reused ? ` ／ 既存DB商品を再利用 ${confirmed.reused}件` : ''}
                    </p>
                  )}
                  <p className="text-sm mt-1 opacity-80">取込ID: <span className="font-mono">{confirmed.import_id}</span></p>
                </div>
              ) : panelView === 'review' ? (
                <OrderListMatchReview
                  apiBaseUrl={apiBaseUrl}
                  onImportUpdated={refreshImportReview}
                  onConfirmImport={confirmImportFromHistory}
                  onResyncImport={resyncImportFromHistory}
                  confirmDisabled={busy}
                />
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-text-primary mb-2">Excelファイル</label>
                    <input
                      ref={inputRef}
                      id={inputId}
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={selectFile}
                      disabled={busy}
                      aria-describedby={`${descriptionId}-file-help`}
                      aria-hidden="true"
                      className="sr-only"
                      tabIndex={-1}
                    />
                    <div className="flex min-h-12 w-full items-stretch overflow-hidden rounded-xl border border-border-card bg-page-bg">
                      <button ref={fileButtonRef} type="button" onClick={openFileChooser} disabled={busy} aria-controls={inputId} aria-describedby={`${descriptionId}-file-help`} className="shrink-0 border-r border-border-card bg-warm-100 px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-warm-200 disabled:opacity-50">
                        ファイルを選択
                      </button>
                      <span className="min-w-0 flex-1 self-center truncate px-4 py-2.5 text-sm text-text-secondary">
                        {selectedFile?.name ?? '選択されていません'}
                      </span>
                    </div>
                    <p id={`${descriptionId}-file-help`} className="mt-1.5 text-xs text-text-secondary">
                      対応形式: .xlsx（{FRANCHISES.map((franchise) => KECAK_SHEET_MAP[franchise]).join('・')}の{FRANCHISES.length}シート）
                    </p>
                  </div>

                  {selectedFile && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl bg-page-bg border border-border-card p-4">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">{selectedFile.name}</p>
                        <p className="text-xs text-text-secondary mt-0.5">{formatFileSize(selectedFile.size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={upload}
                        disabled={busy}
                        className="shrink-0 px-4 py-2 rounded-full text-sm font-semibold bg-text-primary text-white hover:bg-warm-800 disabled:bg-text-primary/40 disabled:cursor-not-allowed"
                      >
                        {pendingAction === 'upload' ? '読み込み中...' : review ? 'もう一度確認' : '内容を確認'}
                      </button>
                    </div>
                  )}

                  {pendingAction === 'upload' && (
                    <div aria-live="polite">
                      <div className="flex justify-between text-xs text-text-secondary mb-1.5">
                        <span>{uploadProgress < 100 ? 'アップロード中...' : 'Excelを検証中...'}</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label="アップロード進捗"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={uploadProgress}
                        className="w-full bg-warm-100 rounded-full h-2 overflow-hidden"
                      >
                        <div className="bg-text-primary h-2 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                      </div>
                    </div>
                  )}

                  {error && <div role="alert" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-4 text-sm text-[#8d3a22]">{error}</div>}
                  {review?.import.structural_valid === false && (
                    <div role="alert" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-4 text-sm text-[#8d3a22]">
                      必須シートまたはヘッダの構成にエラーがあるため、このファイルは反映できません。
                      問題一覧を確認してExcelを修正してください。
                    </div>
                  )}
                  {review && review.import.structural_valid !== false && review.import.persistence_complete !== true && (
                    <div role="alert" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-4 text-sm text-[#8d3a22]">
                      取込データの保存が完了していないため反映できません。履歴の失敗状態を確認し、同じExcelを再読み込みしてください。
                    </div>
                  )}


                  {review && (
                    <div className="space-y-5" aria-live="polite">
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                          <h3 className="text-base font-bold text-text-primary">照合結果</h3>
                          <span className="text-xs text-text-secondary">取込行数: {review.summary.total.toLocaleString()}件</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                          <SummaryCard label="合計" count={review.summary.total} tone="neutral" />
                          <SummaryCard label="照合済み" count={review.summary.matched} tone="success" />
                          <SummaryCard label="曖昧" count={review.summary.ambiguous} tone="warning" />
                          <SummaryCard label="未照合" count={review.summary.unmatched} tone="warning" />
                          <SummaryCard label="不正行" count={review.summary.invalid} tone="danger" />
                          <SummaryCard label="除外済み" count={review.summary.excluded ?? 0} tone="neutral" />
                        </div>
                      </div>

                      {unresolved > 0 && (
                        <div
                          role="alert"
                          className="relative overflow-hidden rounded-2xl border-2 border-amber-500 bg-gradient-to-r from-amber-50 to-[#fff4cf] p-5 pl-6 text-amber-950 shadow-[0_10px_30px_rgba(180,83,9,0.16)]"
                        >
                          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-2 bg-amber-500" />
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-start gap-3">
                              <span
                                aria-hidden="true"
                                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xl font-black text-white shadow-sm"
                              >
                                !
                              </span>
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="inline-flex rounded-full border border-amber-500 bg-white px-2.5 py-0.5 text-xs font-bold text-amber-900">
                                    反映前に確認
                                  </span>
                                  <h3 className="text-base font-bold sm:text-lg">
                                    未解決の行が{unresolved.toLocaleString()}件あります
                                  </h3>
                                </div>
                                <p className="mt-2 text-sm leading-relaxed text-amber-900">
                                  見落としを防ぐため、反映前に曖昧・未照合・不正行を順番に確認します。対応しない商品は最後にまとめて残せます。
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setPanelView('review')}
                              className="shrink-0 rounded-full bg-amber-900 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-950"
                            >
                              未解決{unresolved.toLocaleString()}件を順番に確認
                            </button>
                          </div>
                        </div>
                      )}

                      {franchiseRows.length > 0 && (
                        <div>
                          <h3 className="text-sm font-semibold text-text-primary mb-2">商材別</h3>
                          <div className="overflow-x-auto rounded-xl border border-border-card bg-page-bg">
                            <table className="w-full min-w-[620px] text-sm">
                              <thead>
                                <tr className="text-left text-text-secondary border-b border-border-card bg-warm-100/60">
                                  <th className="px-4 py-2.5 font-medium">商材</th>
                                  <th className="px-4 py-2.5 font-medium text-right">合計</th>
                                  <th className="px-4 py-2.5 font-medium text-right">照合済み</th>
                                  <th className="px-4 py-2.5 font-medium text-right">曖昧</th>
                                  <th className="px-4 py-2.5 font-medium text-right">未照合</th>
                                  <th className="px-4 py-2.5 font-medium text-right">不正行</th>
                                  <th className="px-4 py-2.5 font-medium text-right">除外済み</th>
                                </tr>
                              </thead>
                              <tbody>
                                {franchiseRows.map(([franchise, counts]) => (
                                  <tr key={franchise} className="border-b border-border-card/60 last:border-0">
                                    <td className="px-4 py-2.5 font-medium text-text-primary">{franchiseLabel(franchise)}</td>
                                    <td className="px-4 py-2.5 text-right text-text-secondary">{counts.total.toLocaleString()}</td>
                                    <td className="px-4 py-2.5 text-right text-[#2d5a2f]">{counts.matched.toLocaleString()}</td>
                                    <td className="px-4 py-2.5 text-right text-amber-700">{counts.ambiguous.toLocaleString()}</td>
                                    <td className="px-4 py-2.5 text-right text-amber-700">{counts.unmatched.toLocaleString()}</td>
                                    <td className="px-4 py-2.5 text-right text-[#8d3a22]">{counts.invalid.toLocaleString()}</td>
                                    <td className="px-4 py-2.5 text-right text-text-secondary">{(counts.excluded ?? 0).toLocaleString()}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}



                      {review.issues.length > 0 && (
                        <div className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-4 text-[#8d3a22]">
                          <h3 className="text-sm font-semibold">構成・読み込み上の問題（{review.issues.length}件）</h3>
                          <ul className="mt-2 space-y-1.5 max-h-40 overflow-y-auto">
                            {review.issues.map((issue, index) => (
                              <li key={`${issue.code ?? 'issue'}-${issue.sheet ?? ''}-${issue.row ?? ''}-${index}`} className="text-xs sm:text-sm">
                                <span className="font-medium">
                                  {[issue.sheet, issue.row ? `${issue.row}行目` : null].filter(Boolean).join(' / ')}
                                  {(issue.sheet || issue.row) ? ': ' : ''}
                                </span>
                                {issue.message}
                                {issue.code && <span className="ml-1 opacity-60">[{issue.code}]</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {review.summary.matched === 0 && (
                        <div role="alert" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-4 text-sm text-[#8d3a22]">
                          反映できる照合済み商品がありません。照合結果を確認してから、別のファイルを読み込んでください。
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <footer className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 p-5 sm:p-6 border-t border-border-card">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="px-4 py-2.5 rounded-full text-sm font-medium border border-border-card text-text-secondary hover:bg-warm-100 hover:text-text-primary disabled:opacity-40"
              >
                {confirmed || panelView === 'review' ? '閉じる' : 'キャンセル'}
              </button>
              {review && !confirmed && panelView === 'upload' && (
                <button
                  type="button"
                  onClick={unresolved > 0 ? () => setPanelView('review') : confirmImport}
                  disabled={busy || (unresolved === 0 && !canConfirm)}
                  className="px-5 py-2.5 rounded-full text-sm font-semibold bg-text-primary text-white hover:bg-warm-800 disabled:bg-text-primary/40 disabled:text-white/70 disabled:cursor-not-allowed"
                >
                  {unresolved > 0
                    ? `未解決${unresolved.toLocaleString()}件を確認して次へ`
                    : pendingAction === 'confirm'
                      ? '同期を開始中...'
                      : 'この内容で同期'}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function SummaryCard({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const styles = {
    neutral: 'bg-page-bg border-border-card text-text-primary',
    success: 'bg-[#f3faf0] border-[#bfd4b8] text-[#2d5a2f]',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    danger: 'bg-[#fff0ec] border-[#e3b0a2] text-[#8d3a22]',
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${styles}`}>
      <p className="text-xs opacity-75">{label}</p>
      <p className="text-xl font-bold mt-0.5">{count.toLocaleString()}</p>
    </div>
  );
}
