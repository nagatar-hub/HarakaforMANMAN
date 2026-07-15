'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrderListConfirmResult, OrderListImportResult } from './order-list-import-panel';
import {
  clearDraftMappings,
  draftsForImport,
  firstReviewStatus,
  mappingSelections,
  nextReviewStatus,
  reviewStatusProgress,
  selectionProgress,
  stageDraftMapping,
  unselectedConfirmationMessage,
  unstageDraftMapping,
  type DraftMappingsByImport,
  type DraftMapping,
  type OrderListMappingSelection,
  type ReviewMatchStatus,
} from './order-list-match-review-state';

type RecentImport = Omit<OrderListImportResult, 'issues' | 'import'> & {
  import: OrderListImportResult['import'] & { business_date?: string };
};

type OrderListItem = {
  id: string;
  franchise: string;
  excel_product_id: string;
  sheet_name: string;
  sheet_row_number: number;
  card_name: string;
  grade: string | null;
  expansion: string | null;
  list_no: string | null;
  rarity: string | null;
  image_url: string | null;
  demand: number | null;
  source_price: number | null;
  validation_issues: unknown[];
  match_status: string;
  match_candidates: unknown[];
  match_note: string | null;
};

type DbCard = {
  id: string;
  franchise: string;
  tag: string | null;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
  alt_image_url: string | null;
};

type ItemsResponse = { items: OrderListItem[]; total: number };
type ApiErrorPayload = { error?: string | { message?: string }; message?: string };

const STATUS_OPTIONS: Array<{ value: ReviewMatchStatus; label: string }> = [
  { value: 'ambiguous', label: '曖昧' },
  { value: 'unmatched', label: '未照合' },
  { value: 'invalid', label: '不正行' },
];
const ITEMS_PER_PAGE = 40;

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload as ApiErrorPayload;
  if (typeof value.error === 'string' && value.error.trim()) return value.error;
  if (value.error && typeof value.error === 'object' && value.error.message) return value.error.message;
  return value.message || fallback;
}

function isRecentImport(value: unknown): value is RecentImport {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecentImport>;
  return Boolean(item.import?.id && item.import.filename && item.summary && typeof item.summary.matched === 'number');
}

function isItemsResponse(value: unknown): value is ItemsResponse {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ItemsResponse>;
  return Array.isArray(item.items) && typeof item.total === 'number';
}

function isDbCard(value: unknown): value is DbCard {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<DbCard>;
  return Boolean(item.id && item.franchise && item.card_name);
}

function candidateIds(item: OrderListItem): string[] {
  return item.match_candidates.filter((value): value is string => typeof value === 'string');
}

function franchiseLabel(value: string): string {
  if (value.toUpperCase() === 'POKEMON') return 'ポケモン';
  if (value.toUpperCase() === 'ONE PIECE') return 'ワンピース';
  if (value.toUpperCase().startsWith('YU-GI-OH')) return '遊戯王';
  return value;
}

function statusLabel(value: string): string {
  return ({ parsed: '確認待ち', confirmed: '反映待ち', processing: '反映中', applied: '反映済み', failed: '失敗' } as Record<string, string>)[value] ?? value;
}

function unresolvedCount(item: RecentImport): number {
  return item.summary.ambiguous + item.summary.unmatched + item.summary.invalid;
}

function canMapImport(status: string): boolean {
  return status !== 'confirmed' && status !== 'processing';
}

function cardLabel(card: DbCard): string {
  return [card.card_name, card.grade, card.list_no, card.tag].filter(Boolean).join(' / ');
}

function safeImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

type ExternalImagePreviewProps = {
  urls: Array<string | null>;
  alt: string;
  className: string;
  emptyLabel: string;
};

function ExternalImagePreview({ urls, alt, className, emptyLabel }: ExternalImagePreviewProps) {
  const sources = [...new Set(urls.map(safeImageUrl).filter((value): value is string => Boolean(value)))];
  const sourceKey = sources.join('\u0000');
  const [failure, setFailure] = useState({ sourceKey, count: 0 });
  const failedCount = failure.sourceKey === sourceKey ? failure.count : 0;
  const currentUrl = sources[failedCount] ?? null;

  if (!currentUrl) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded border border-border-card bg-white px-1 text-center text-[10px] text-text-secondary ${className}`}>
        {sources.length > 0 ? '画像を表示できません' : emptyLabel}
      </span>
    );
  }

  return (
    <a href={currentUrl} target="_blank" rel="noreferrer" title="画像を拡大表示" className={`block shrink-0 overflow-hidden rounded border border-border-card bg-white ${className}`}>
      <img
        key={currentUrl}
        src={currentUrl}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailure({ sourceKey, count: failedCount + 1 })}
        className="h-full w-full object-contain"
      />
    </a>
  );
}

function canConfirmImport(item: RecentImport, stagedCount = 0): boolean {
  return (item.import.status === 'parsed' || item.import.status === 'failed')
    && item.import.structural_valid !== false
    && item.import.persistence_complete === true
    && item.summary.matched + stagedCount > 0;
}

function issueLabel(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  if (!issue || typeof issue !== 'object') return String(issue);
  const value = issue as { code?: unknown; message?: unknown };
  const message = typeof value.message === 'string' ? value.message : JSON.stringify(issue);
  return typeof value.code === 'string' ? `${message} [${value.code}]` : message;
}

export function OrderListMatchReview({
  apiBaseUrl,
  onImportUpdated,
  onConfirmImport,
  confirmDisabled = false,
}: {
  apiBaseUrl: string;
  onImportUpdated?: (importId: string) => void | Promise<void>;
  onConfirmImport: (
    importId: string,
    mappings: OrderListMappingSelection[],
    allowUnresolved: boolean,
  ) => Promise<OrderListConfirmResult>;
  confirmDisabled?: boolean;
}) {
  const endpointBase = apiBaseUrl.replace(/\/$/, '');
  const [imports, setImports] = useState<RecentImport[]>([]);
  const [selectedImportId, setSelectedImportId] = useState('');
  const [activeStatus, setActiveStatus] = useState<ReviewMatchStatus>('ambiguous');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<OrderListItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [loadingImports, setLoadingImports] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsLoadError, setItemsLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedDbCardId, setSelectedDbCardId] = useState('');
  const [draftMappingsByImport, setDraftMappingsByImport] = useState<DraftMappingsByImport>({});
  const [unlockedStatusByImport, setUnlockedStatusByImport] = useState<Record<string, ReviewMatchStatus>>({});
  const [savingMappingsImportId, setSavingMappingsImportId] = useState<string | null>(null);
  const [confirmingImportId, setConfirmingImportId] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [itemsRevision, setItemsRevision] = useState(0);
  const [loadedItemsQueryKey, setLoadedItemsQueryKey] = useState<string | null>(null);
  const [cardsByFranchise, setCardsByFranchise] = useState<Record<string, DbCard[]>>({});
  const [loadingFranchise, setLoadingFranchise] = useState<string | null>(null);
  const cardCacheRef = useRef<Record<string, DbCard[]>>({});
  const reviewTopRef = useRef<HTMLDivElement>(null);
  const confirmationDialogRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const closeConfirmation = useCallback(() => {
    setConfirmationOpen(false);
    window.setTimeout(() => confirmationTriggerRef.current?.focus(), 0);
  }, []);

  const confirmationCancelRef = useRef<HTMLButtonElement>(null);

  const selectedImport = imports.find((item) => item.import.id === selectedImportId) ?? null;
  const editingItem = items.find((item) => item.id === editingItemId) ?? null;
  const draftMappings = draftsForImport(draftMappingsByImport, selectedImportId);
  const progress = selectedImport
    ? selectionProgress(selectedImport.summary, draftMappings)
    : {
      staged: 0,
      reflectable: 0,
      unselected: 0,
      invalid: 0,
      ambiguousSelected: 0,
      ambiguousUnselected: 0,
      unmatchedSelected: 0,
      unmatchedUnselected: 0,
    };
  const totalPages = Math.max(1, Math.ceil(itemsTotal / ITEMS_PER_PAGE));
  const activeStatusTotal = selectedImport?.summary[activeStatus] ?? 0;
  const currentItemsQueryKey = selectedImportId
    ? `${selectedImportId}:${activeStatus}:${page}:${itemsRevision}:${activeStatusTotal}`
    : '';
  const reviewSteps = selectedImport
    ? STATUS_OPTIONS.filter((option) => selectedImport.summary[option.value] > 0)
    : [];
  const activeStepIndex = Math.max(0, reviewSteps.findIndex((option) => option.value === activeStatus));
  const unlockedStatus = unlockedStatusByImport[selectedImportId] ?? reviewSteps[0]?.value;
  const unlockedStepIndex = Math.max(0, reviewSteps.findIndex((option) => option.value === unlockedStatus));
  const currentStatusProgress = selectedImport
    ? reviewStatusProgress(selectedImport.summary, draftMappings, activeStatus)
    : { total: 0, selected: 0, remaining: 0 };
  const followingStatus = selectedImport
    ? nextReviewStatus(activeStatus, selectedImport.summary)
    : null;
  const followingStatusLabel = STATUS_OPTIONS.find((option) => option.value === followingStatus)?.label
    ?? '次の工程';
  const atFinalReviewStep = reviewSteps.length > 0
    && page >= totalPages && followingStatus === null
    && !loadingItems && loadedItemsQueryKey === currentItemsQueryKey;
  const canSaveAppliedMappings = selectedImport?.import.status === 'applied' && progress.staged > 0;
  const finalActionAvailable = atFinalReviewStep
    && (Boolean(selectedImport && canConfirmImport(selectedImport, progress.staged)) || canSaveAppliedMappings);
  const finalWarning = unselectedConfirmationMessage(
    progress,
    selectedImport?.import.status === 'applied' ? 'save' : 'reflect',
  );

  const loadImports = useCallback(async (signal?: AbortSignal) => {
    setLoadingImports(true);
    setError(null);
    try {
      const response = await fetch(`${endpointBase}/api/order-list/imports?limit=100`, { headers: { Accept: 'application/json' }, signal });
      const payload = parseJson(await response.text());
      if (!response.ok) throw new Error(errorMessage(payload, `取込履歴の取得に失敗しました（${response.status}）`));
      if (!Array.isArray(payload)) throw new Error('取込履歴の形式が正しくありません。');
      const entries = payload.filter(isRecentImport);
      setImports(entries);
      setSelectedImportId((current) => entries.some((entry) => entry.import.id === current)
        ? current
        : entries.find((entry) => unresolvedCount(entry) > 0)?.import.id ?? entries[0]?.import.id ?? '');
    } catch (loadError) {
      if ((loadError as Error).name !== 'AbortError') setError(loadError instanceof Error ? loadError.message : '取込履歴の取得に失敗しました。');
    } finally {
      if (!signal?.aborted) setLoadingImports(false);
    }
  }, [endpointBase]);

  const loadCards = useCallback(async (franchise: string) => {
    if (cardCacheRef.current[franchise]) return cardCacheRef.current[franchise];
    setLoadingFranchise(franchise);
    try {
      const response = await fetch(`${endpointBase}/api/order-list/db-cards?franchise=${encodeURIComponent(franchise)}`, { headers: { Accept: 'application/json' } });
      const payload = parseJson(await response.text());
      if (!response.ok) throw new Error(errorMessage(payload, `DB商品の取得に失敗しました（${response.status}）`));
      if (!Array.isArray(payload)) throw new Error('DB商品一覧の形式が正しくありません。');
      const cards = payload.filter(isDbCard);
      cardCacheRef.current[franchise] = cards;
      setCardsByFranchise((current) => ({ ...current, [franchise]: cards }));
      return cards;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'DB商品の取得に失敗しました。');
      return [];
    } finally {
      setLoadingFranchise((current) => current === franchise ? null : current);
    }
  }, [endpointBase]);

  useEffect(() => {
    cardCacheRef.current = {};
    setCardsByFranchise({});
    setImports([]);
    setSelectedImportId('');
    setItems([]);
    setItemsTotal(0);
    setEditingItemId(null);
    setSelectedDbCardId('');
    setDraftMappingsByImport({});
    setUnlockedStatusByImport({});
    setConfirmationOpen(false);
    setMessage(null);
    setError(null);

    const controller = new AbortController();
    void loadImports(controller.signal);
    return () => controller.abort();
  }, [loadImports]);

  useEffect(() => {
    if (!selectedImport || selectedImport.summary[activeStatus] > 0) return;
    const initialStatus = firstReviewStatus(selectedImport.summary);
    if (!initialStatus || initialStatus === activeStatus) return;
    setActiveStatus(initialStatus);
    setPage(1);
    setUnlockedStatusByImport((current) => ({
      ...current,
      [selectedImport.import.id]: initialStatus,
    }));
  }, [activeStatus, selectedImport]);

  useEffect(() => {
    if (!selectedImportId) { setItems([]); setItemsTotal(0); setItemsLoadError(null); setLoadedItemsQueryKey(null); return; }
    const controller = new AbortController();
    const query = new URLSearchParams({ status: activeStatus, page: String(page), limit: String(ITEMS_PER_PAGE) });
    setLoadingItems(true);
    setError(null);
    setItemsLoadError(null);
    setLoadedItemsQueryKey(null);
    setEditingItemId(null);
    void (async () => {
      try {
        const response = await fetch(`${endpointBase}/api/order-list/imports/${encodeURIComponent(selectedImportId)}/items?${query}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
        const payload = parseJson(await response.text());
        if (!response.ok) throw new Error(errorMessage(payload, `未照合行の取得に失敗しました（${response.status}）`));
        if (!isItemsResponse(payload)) throw new Error('未照合行の形式が正しくありません。');
        setItems(payload.items);
        setItemsTotal(payload.total);
        setLoadedItemsQueryKey(currentItemsQueryKey);
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') {
          const loadMessage = loadError instanceof Error ? loadError.message : '未照合行の取得に失敗しました。';
          setItemsLoadError(loadMessage);
          setError(loadMessage);
        }
      } finally {
        if (!controller.signal.aborted) setLoadingItems(false);
      }
    })();
    return () => controller.abort();
  }, [activeStatus, currentItemsQueryKey, endpointBase, itemsRevision, page, selectedImportId]);
  useEffect(() => {
    if (!confirmationOpen) return;
    confirmationCancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeConfirmation();
        return;
      }
      if (event.key !== 'Tab' || !confirmationDialogRef.current) return;
      const focusable = Array.from(confirmationDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !confirmationDialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeConfirmation, confirmationOpen]);


  useEffect(() => {
    if (activeStatus !== 'ambiguous') return;
    [...new Set(items.filter((item) => candidateIds(item).length > 0).map((item) => item.franchise))]
      .forEach((franchise) => { void loadCards(franchise); });
  }, [activeStatus, items, loadCards]);

  const availableCards = editingItem ? cardsByFranchise[editingItem.franchise] ?? [] : [];
  const filteredCards = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ja');
    return (query ? availableCards.filter((card) => [card.card_name, card.grade, card.list_no, card.tag, card.id]
      .filter(Boolean).some((value) => String(value).toLocaleLowerCase('ja').includes(query))) : availableCards).slice(0, 100);
  }, [availableCards, search]);

  function scrollReviewTop(): void {
    window.setTimeout(() => reviewTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  function openReviewStatus(status: ReviewMatchStatus): void {
    setActiveStatus(status);
    setPage(1);
    setEditingItemId(null);
    setSelectedDbCardId('');
    setConfirmationOpen(false);
    scrollReviewTop();
  }

  function unlockAndOpenStatus(status: ReviewMatchStatus): void {
    if (!selectedImport) return;
    setUnlockedStatusByImport((current) => ({
      ...current,
      [selectedImport.import.id]: status,
    }));
    openReviewStatus(status);
  }

  function openReviewPage(nextPage: number): void {
    setPage(Math.max(1, Math.min(totalPages, nextPage)));
    setEditingItemId(null);
    setSelectedDbCardId('');
    scrollReviewTop();
  }

  function advanceReview(): void {
    if (page < totalPages) {
      openReviewPage(page + 1);
      return;
    }
    if (!followingStatus) return;
    const nextLabel = STATUS_OPTIONS.find((option) => option.value === followingStatus)?.label ?? followingStatus;
    unlockAndOpenStatus(followingStatus);
    setMessage(`${nextLabel}${selectedImport?.summary[followingStatus].toLocaleString() ?? 0}件の確認へ進みました。`);
  }

  function selectRecentImport(importId: string): void {
    const nextImport = imports.find((entry) => entry.import.id === importId);
    const initialStatus = nextImport ? firstReviewStatus(nextImport.summary) ?? 'ambiguous' : 'ambiguous';
    setSelectedImportId(importId);
    setActiveStatus(initialStatus);
    setPage(1);
    setMessage(null);
    setConfirmationOpen(false);
    if (nextImport) {
      setUnlockedStatusByImport((current) => ({
        ...current,
        [nextImport.import.id]: initialStatus,
      }));
    }
  }

  async function editItem(item: OrderListItem) {
    setEditingItemId(item.id);
    setSearch('');
    setSelectedDbCardId(draftMappings[item.id]?.dbCardId ?? '');
    setMessage(null);
    await loadCards(item.franchise);
  }

  function stageMapping(item: OrderListItem, card: DbCard): void {
    if (!selectedImport
      || (item.match_status !== 'ambiguous' && item.match_status !== 'unmatched')
      || confirmingImportId
      || savingMappingsImportId) return;
    const matchStatus = item.match_status === 'ambiguous' ? 'ambiguous' : 'unmatched';
    const finalActionLabel = selectedImport.import.status === 'applied' ? '保存' : '反映';
    const draft: DraftMapping = {
      itemId: item.id,
      dbCardId: card.id,
      cardLabel: cardLabel(card),
      matchStatus,
    };
    const wasSelected = Boolean(draftMappings[item.id]);
    setDraftMappingsByImport((current) => stageDraftMapping(current, selectedImport.import.id, {
      ...draft,
    }));
    setEditingItemId(null);
    setSelectedDbCardId('');
    setError(null);

    const nextDrafts = { ...draftMappings, [item.id]: draft };
    const statusProgress = reviewStatusProgress(selectedImport.summary, nextDrafts, matchStatus);
    const nextStatus = nextReviewStatus(matchStatus, selectedImport.summary);
    if (!wasSelected && statusProgress.remaining === 0 && nextStatus) {
      const currentLabel = STATUS_OPTIONS.find((option) => option.value === matchStatus)?.label ?? matchStatus;
      const nextLabel = STATUS_OPTIONS.find((option) => option.value === nextStatus)?.label ?? nextStatus;
      unlockAndOpenStatus(nextStatus);
      setMessage(`${currentLabel}の確認が完了しました。続けて${nextLabel}${selectedImport.summary[nextStatus].toLocaleString()}件を確認してください。`);
      return;
    }
    if (!wasSelected && statusProgress.remaining === 0) {
      setMessage(`未解決商品の選択が完了しました。内容を確認して最後のボタンからまとめて${finalActionLabel}してください。`);
      return;
    }
    setMessage(`仮選択しました。まだDBには保存されていません。最後のボタンでまとめて${finalActionLabel}します。`);
  }

  function removeStagedMapping(itemId: string): void {
    if (!selectedImport || confirmingImportId || savingMappingsImportId) return;
    setDraftMappingsByImport((current) => unstageDraftMapping(current, selectedImport.import.id, itemId));
    if (editingItemId === itemId) {
      setEditingItemId(null);
      setSelectedDbCardId('');
    }
    setMessage('仮選択を解除しました。');
  }

  function requestFinalAction(): void {
    if (!selectedImport) return;
    const warning = finalWarning;
    if (warning) {
      confirmationTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmationOpen(true);
      return;
    }
    if (selectedImport.import.status === 'applied') {
      void saveAppliedMappings();
    } else {
      void confirmSelectedImport();
    }
  }

  function continueFinalAction(): void {
    if (!selectedImport) return;
    setConfirmationOpen(false);
    if (selectedImport.import.status === 'applied') {
      void saveAppliedMappings();
    } else {
      void confirmSelectedImport();
    }
  }

  async function confirmSelectedImport(): Promise<void> {
    if (!selectedImport
      || !canConfirmImport(selectedImport, progress.staged)
      || confirmDisabled
      || confirmingImportId
      || savingMappingsImportId) return;

    const selections = mappingSelections(draftMappings);
    setConfirmingImportId(selectedImport.import.id);
    setConfirmationOpen(false);
    setError(null);
    setMessage(null);
    try {
      await onConfirmImport(
        selectedImport.import.id,
        selections,
        progress.unselected > 0,
      );
      setDraftMappingsByImport((current) => clearDraftMappings(current, selectedImport.import.id));
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '反映の開始に失敗しました。');
    } finally {
      setConfirmingImportId(null);
    }
  }

  async function saveAppliedMappings(): Promise<void> {
    if (!selectedImport
      || selectedImport.import.status !== 'applied'
      || savingMappingsImportId
      || confirmingImportId) return;
    const selections = mappingSelections(draftMappings);
    if (selections.length === 0) return;

    setSavingMappingsImportId(selectedImport.import.id);
    setConfirmationOpen(false);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${endpointBase}/api/order-list/imports/${encodeURIComponent(selectedImport.import.id)}/mappings`, {
        method: 'PATCH',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: selections }),
      });
      const payload = parseJson(await response.text());
      if (!response.ok) throw new Error(errorMessage(payload, `対応表の保存に失敗しました（${response.status}）`));

      setDraftMappingsByImport((current) => clearDraftMappings(current, selectedImport.import.id));
      setEditingItemId(null);
      setSelectedDbCardId('');
      setMessage(`${selections.length.toLocaleString()}件の対応表を保存しました。次回以降のExcel取込から使用されます。`);
      await Promise.resolve(onImportUpdated?.(selectedImport.import.id)).catch(() => undefined);
      await loadImports();
      setItemsRevision((current) => current + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '対応表の保存に失敗しました。');
    } finally {
      setSavingMappingsImportId(null);
    }
  }

  return <div className="space-y-5">
    <div className="rounded-xl border border-border-card bg-page-bg p-4">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0">
          <label htmlFor="order-list-recent-import" className="block text-sm font-semibold text-text-primary mb-1.5">最近の取込</label>
          <select id="order-list-recent-import" value={selectedImportId} onChange={(event) => selectRecentImport(event.target.value)} disabled={loadingImports || imports.length === 0 || confirmDisabled || confirmingImportId !== null || savingMappingsImportId !== null} className="w-full rounded-lg border border-border-card bg-card-bg px-3 py-2.5 text-sm text-text-primary disabled:opacity-50">
            {imports.length === 0 && <option value="">取込履歴がありません</option>}
            {imports.map((entry) => <option key={entry.import.id} value={entry.import.id}>{entry.import.business_date ?? entry.import.imported_at.slice(0, 10)} / {entry.import.filename} / 未解決{unresolvedCount(entry)}件 / {statusLabel(entry.import.status)}</option>)}
          </select>
        </div>
        <button type="button" onClick={() => { void loadImports(); }} disabled={loadingImports || confirmDisabled || confirmingImportId !== null || savingMappingsImportId !== null} className="shrink-0 rounded-full border border-border-card px-4 py-2.5 text-sm font-semibold text-text-secondary hover:bg-warm-100 disabled:opacity-40">{loadingImports ? '更新中...' : '履歴を更新'}</button>
      </div>
    </div>
    {error && !selectedImport && <div role="alert" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-3 text-sm text-[#8d3a22]">{error}</div>}

    {selectedImport && <>
      <div ref={reviewTopRef} className="scroll-mt-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-text-primary truncate">{selectedImport.import.filename}</h3><span className="rounded-full border border-border-card bg-page-bg px-2.5 py-0.5 text-xs text-text-secondary">{statusLabel(selectedImport.import.status)}</span></div><p className="mt-1 text-xs text-text-secondary">取込ID: <span className="font-mono">{selectedImport.import.id}</span></p></div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <p className="text-xs text-text-secondary">照合済み {selectedImport.summary.matched.toLocaleString()} / 今回選択 {progress.staged.toLocaleString()} / 未選択 {progress.unselected.toLocaleString()}{progress.invalid > 0 ? ` / 入力エラー ${progress.invalid.toLocaleString()}` : ''}</p>
          {finalActionAvailable && (
            <button
              type="button"
              onClick={requestFinalAction}
              disabled={confirmDisabled || confirmingImportId !== null || savingMappingsImportId !== null}
              className="rounded-full bg-text-primary px-4 py-2 text-xs font-semibold text-white disabled:bg-text-primary/40 disabled:cursor-not-allowed"
            >
              {selectedImport.import.status === 'applied'
                ? savingMappingsImportId === selectedImport.import.id ? '対応表を保存中...' : '選択した対応をまとめて保存'
                : confirmingImportId === selectedImport.import.id ? '反映を開始中...' : 'この取込を確認して反映'}
            </button>
          )}
        </div>
      </div>
      {selectedImport.import.status === 'applied' && <div role="note" className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">反映済み取込で確定した対応は次回以降のExcel取込から使用されます。すでに反映済みの価格・画像には遡って適用されません。</div>}
      {(selectedImport.import.status === 'parsed' || selectedImport.import.status === 'failed')
        && selectedImport.import.structural_valid !== false
        && selectedImport.import.persistence_complete !== true && (
          <div role="note" className="rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-3 text-sm text-[#8d3a22]">
            取込データの保存が完了していないため、この履歴からは反映を開始できません。同じExcelを再読み込みしてください。
          </div>
        )}
      {!canMapImport(selectedImport.import.status) && <div role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">現在は{statusLabel(selectedImport.import.status)}のため閲覧のみです。処理完了後に対応付けできます。</div>}
      {reviewSteps.length > 0 ? <>
        <div role="note" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-amber-800">確認工程 {activeStepIndex + 1} / {reviewSteps.length}</p>
              <p className="mt-1 text-base font-bold">{STATUS_OPTIONS.find((option) => option.value === activeStatus)?.label}を確認中</p>
              <p className="mt-1 text-sm leading-relaxed">見落としを防ぐため、各工程を順番に確認してから最後にまとめて{selectedImport.import.status === 'applied' ? '保存' : '反映'}します。</p>
            </div>
            <div className="shrink-0 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-bold">
              {activeStatus === 'invalid'
                ? `確認対象 ${currentStatusProgress.total.toLocaleString()}件`
                : `選択 ${currentStatusProgress.selected.toLocaleString()} / ${currentStatusProgress.total.toLocaleString()}件`}
            </div>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="未解決商品の確認工程">
          {reviewSteps.map((option, index) => {
            const statusProgress = reviewStatusProgress(selectedImport.summary, draftMappings, option.value);
            const locked = index > unlockedStepIndex;
            const active = activeStatus === option.value;
            return <button
              key={option.value}
              type="button"
              aria-current={active ? 'step' : undefined}
              disabled={locked}
              onClick={() => openReviewStatus(option.value)}
              className={`rounded-xl border-2 px-4 py-3 text-left transition-colors ${active ? 'border-text-primary bg-text-primary text-white' : locked ? 'border-border-card bg-warm-100 text-text-secondary opacity-55' : 'border-border-card bg-card-bg text-text-primary hover:bg-warm-100'}`}
            >
              <span className="block text-sm font-bold">{index + 1}. {option.label}</span>
              <span className={`mt-1 block text-xs ${active ? 'text-white/80' : 'text-text-secondary'}`}>
                {option.value === 'invalid'
                  ? `${statusProgress.total.toLocaleString()}件を確認`
                  : `${statusProgress.selected.toLocaleString()} / ${statusProgress.total.toLocaleString()}件を選択`}
              </span>
              {locked && <span className="mt-1 block text-[11px]">前の工程を終えると開きます</span>}
            </button>;
          })}
        </div>
      </> : (
        <div role="note" className="rounded-xl border border-[#bfd4b8] bg-[#f3faf0] p-4 text-sm font-semibold text-[#2d5a2f]">未解決の商品はありません。</div>
      )}
      {message && <div role="status" className="rounded-xl border border-[#bfd4b8] bg-[#f3faf0] p-3 text-sm text-[#2d5a2f]">{message}</div>}
      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-[#e3b0a2] bg-[#fff0ec] p-3 text-sm text-[#8d3a22] sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          {itemsLoadError && (
            <button
              type="button"
              onClick={() => { setError(null); setItemsLoadError(null); setItemsRevision((current) => current + 1); }}
              className="shrink-0 rounded-full border border-[#e3b0a2] bg-white px-3.5 py-2 text-xs font-bold hover:bg-[#fff8f6]"
            >
              この一覧を再読み込み
            </button>
          )}
        </div>
      )}
      {loadingItems ? <p role="status" className="py-8 text-center text-sm text-text-secondary">未照合行を読み込み中...</p> : items.length === 0 ? <div className="rounded-xl border border-border-card bg-page-bg p-6 text-center text-sm text-text-secondary">この状態の行はありません。</div> : <div className="space-y-3">
        {items.map((item) => {
          const ids = candidateIds(item);
          const cards = cardsByFranchise[item.franchise] ?? [];
          const canMap = item.match_status !== 'invalid'
            && canMapImport(selectedImport.import.status)
            && selectedImport.import.structural_valid !== false
            && selectedImport.import.persistence_complete === true
            && !confirmDisabled && confirmingImportId === null && savingMappingsImportId === null;
          const isEditing = item.id === editingItemId;
          const draftMapping = draftMappings[item.id];
          const selectedCard = cards.find((card) => card.id === selectedDbCardId);
          const excelImageUrl = safeImageUrl(item.image_url);
          return <article key={item.id} className="rounded-xl border border-border-card bg-card-bg p-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div className="flex min-w-0 items-start gap-4">
                <ExternalImagePreview
                  urls={[item.image_url]}
                  alt={`${item.card_name}のExcel画像`}
                  className="h-32 w-24 sm:h-36 sm:w-28"
                  emptyLabel="Excel画像なし"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold text-text-primary">{item.card_name}</h4><span className="rounded-full bg-warm-100 px-2 py-0.5 text-xs text-text-secondary">{franchiseLabel(item.franchise)}</span>{draftMapping && <span className="rounded-full border border-[#bfd4b8] bg-[#f3faf0] px-2 py-0.5 text-xs font-bold text-[#2d5a2f]">選択済み・未反映</span>}{item.match_status === 'invalid' && <span className="rounded-full border border-[#e3b0a2] bg-[#fff0ec] px-2 py-0.5 text-xs font-bold text-[#8d3a22]">対応付け不可</span>}</div>
                  <p className="mt-1 text-xs text-text-secondary">Excel商品ID: <span className="font-mono">{item.excel_product_id}</span> / {item.sheet_name} {item.sheet_row_number}行目</p>
                  <p className="mt-1 text-xs text-text-secondary">{[item.grade, item.expansion, item.list_no, item.rarity].filter(Boolean).join(' / ') || '商品属性なし'} / {item.source_price === null ? '価格なし' : `${item.source_price.toLocaleString()}円`} / 募集数 {item.demand ?? 'なし'}</p>
                  {excelImageUrl && <a href={excelImageUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-blue-700 underline">Excel画像を別タブで開く</a>}
                </div>
              </div>
              {canMap && <button type="button" onClick={() => { void editItem(item); }} className="shrink-0 rounded-full border border-border-card px-3.5 py-2 text-xs font-semibold text-text-primary hover:bg-warm-100 disabled:opacity-40">{isEditing ? '商品を選択中' : draftMapping ? '選択を変更' : 'DB商品を選択'}</button>}
            </div>
            {item.match_note && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{item.match_note}</p>}
            {draftMapping && (
              <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#bfd4b8] bg-[#f3faf0] px-3 py-2 text-xs text-[#2d5a2f]">
                <span>仮選択: {draftMapping.cardLabel}（まだDBには保存されていません）</span>
                <button type="button" onClick={() => removeStagedMapping(item.id)} className="rounded-full border border-[#bfd4b8] bg-white px-2.5 py-1 font-semibold">選択を解除</button>
              </div>
            )}
            {ids.length > 0 && (
              <div className="mt-3 border-t border-border-card pt-3">
                <p className="text-xs font-semibold text-text-primary">自動照合の候補（{ids.length}件）</p>
                <ul className="mt-1.5 space-y-1">
                  {ids.map((id) => {
                    const card = cards.find((candidate) => candidate.id === id);
                    return (
                      <li key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-page-bg px-3 py-2 text-xs text-text-secondary">
                        <div className="flex min-w-0 items-center gap-3">
                          {card && (
                            <ExternalImagePreview
                              urls={[card.image_url, card.alt_image_url]}
                              alt={`${card.card_name}のDB画像`}
                              className="h-14 w-10"
                              emptyLabel="DB画像なし"
                            />
                          )}
                          <span>{card ? cardLabel(card) : loadingFranchise === item.franchise ? '候補情報を読み込み中...' : `DB商品ID: ${id}`}</span>
                        </div>
                        {canMap && card && (
                          <button
                            type="button"
                            aria-pressed={draftMapping?.dbCardId === card.id}
                            onClick={() => stageMapping(item, card)}
                            className={`rounded-full border px-2.5 py-1 font-semibold ${draftMapping?.dbCardId === card.id ? 'border-[#8eb286] bg-[#f3faf0] text-[#2d5a2f]' : 'border-border-card bg-card-bg text-text-primary'}`}
                          >
                            {draftMapping?.dbCardId === card.id ? '選択済み' : 'この候補を選択'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {item.validation_issues.length > 0 && <div className="mt-3 border-t border-border-card pt-3 text-xs text-[#8d3a22]"><p className="font-semibold">入力エラー</p><ul className="mt-1 list-disc pl-5">{item.validation_issues.map((issue, index) => <li key={`${item.id}-issue-${index}`}>{issueLabel(issue)}</li>)}</ul></div>}
            {isEditing && canMap && <div className="mt-4 rounded-xl border border-border-card bg-page-bg p-3">
              <label htmlFor={`db-card-search-${item.id}`} className="block text-xs font-semibold text-text-primary">DB商品を検索</label><input id={`db-card-search-${item.id}`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名・リスト番号・グレード・タグ" className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm" />
              <label htmlFor={`db-card-select-${item.id}`} className="mt-3 block text-xs font-semibold text-text-primary">対応先（最大100件表示）</label><select id={`db-card-select-${item.id}`} value={selectedDbCardId} onChange={(event) => setSelectedDbCardId(event.target.value)} disabled={loadingFranchise === item.franchise} className="mt-1.5 w-full rounded-lg border border-border-card bg-card-bg px-3 py-2 text-sm disabled:opacity-50"><option value="">DB商品を選択してください</option>{filteredCards.map((card) => <option key={card.id} value={card.id}>{cardLabel(card)}</option>)}</select>
              {availableCards.length > 100 && !search.trim() && <p className="mt-1 text-xs text-text-secondary">候補が多いため検索欄で絞り込んでください。</p>}
              {selectedCard && (
                <div className="mt-2 flex items-center gap-3 rounded-lg border border-border-card bg-card-bg p-2">
                  <ExternalImagePreview
                    urls={[selectedCard.image_url, selectedCard.alt_image_url]}
                    alt={`${selectedCard.card_name}のDB画像`}
                    className="h-20 w-14"
                    emptyLabel="DB画像なし"
                  />
                  <div className="min-w-0 text-xs text-text-secondary">
                    <p>選択中: {cardLabel(selectedCard)}</p>
                    <p className="mt-1">通常画像を表示し、取得できない場合だけ代替画像へ切り替えます。</p>
                  </div>
                </div>
              )}
              {selectedImport.import.status === 'applied' && <p className="mt-2 text-xs font-medium text-blue-800">次回のExcel取込から有効です。反映済み出力は変更しません。</p>}
              <p className="mt-2 text-xs text-text-secondary">ここでは仮選択だけ行い、DB保存は最後のボタンでまとめて実行します。</p>
              <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => { setEditingItemId(null); setSelectedDbCardId(''); }} className="rounded-full border border-border-card px-3.5 py-2 text-xs text-text-secondary disabled:opacity-40">キャンセル</button><button type="button" onClick={() => { if (selectedCard) stageMapping(item, selectedCard); }} disabled={!selectedCard} className="rounded-full bg-text-primary px-4 py-2 text-xs font-semibold text-white disabled:bg-text-primary/40">この商品を選択</button></div>
            </div>}
          </article>;
        })}
      </div>}
      {itemsTotal > ITEMS_PER_PAGE && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" onClick={() => openReviewPage(page - 1)} disabled={page <= 1 || loadingItems} className="rounded-full border border-border-card px-3.5 py-2 text-xs disabled:opacity-40">前へ</button>
          <span className="text-xs text-text-secondary">{page} / {totalPages}ページ（{itemsTotal.toLocaleString()}件）</span>
          <button type="button" onClick={() => openReviewPage(page + 1)} disabled={page >= totalPages || loadingItems} className="rounded-full border border-border-card px-3.5 py-2 text-xs disabled:opacity-40">次へ</button>
        </div>
      )}
      {reviewSteps.length > 0 && !atFinalReviewStep && (
        <div className="mt-2 flex flex-col gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-bold text-amber-950">この工程を確認して、次へ進んでください</p>
            <p className="mt-1 text-xs leading-relaxed text-amber-900">
              {page < totalPages
                ? `残り${(totalPages - page).toLocaleString()}ページあります。`
                : currentStatusProgress.remaining > 0
                  ? `未選択${currentStatusProgress.remaining.toLocaleString()}件を残す場合も、次の工程へ進んだあと最後にもう一度確認します。`
                  : `${STATUS_OPTIONS.find((option) => option.value === activeStatus)?.label}の選択が完了しています。`}
            </p>
          </div>
          <button type="button" onClick={advanceReview} disabled={loadingItems} className="shrink-0 rounded-full bg-amber-950 px-5 py-2.5 text-sm font-bold text-white hover:bg-black disabled:opacity-40">
            {page < totalPages
              ? `次のページへ（${page + 1} / ${totalPages}）`
              : currentStatusProgress.remaining > 0
                ? `未選択${currentStatusProgress.remaining.toLocaleString()}件を残して次へ：${followingStatusLabel}`
                : `次へ：${followingStatusLabel}`}
          </button>
        </div>
      )}
      {atFinalReviewStep && canConfirmImport(selectedImport, progress.staged) && (
        <div className="mt-2 flex flex-col gap-3 rounded-xl border border-border-card bg-page-bg p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-secondary">反映対象 {progress.reflectable.toLocaleString()}件（今回選択 {progress.staged.toLocaleString()}件） / 未選択 {progress.unselected.toLocaleString()}件{progress.invalid > 0 ? ` / 入力エラー ${progress.invalid.toLocaleString()}件` : ''}</p>
          <button
            type="button"
            aria-label="この取込を確認して反映（一覧下部）"
            onClick={requestFinalAction}
            disabled={confirmDisabled || confirmingImportId !== null || savingMappingsImportId !== null}
            className="shrink-0 rounded-full bg-text-primary px-5 py-2.5 text-sm font-semibold text-white disabled:bg-text-primary/40 disabled:cursor-not-allowed"
          >
            {confirmingImportId === selectedImport.import.id ? '反映を開始中...' : 'この取込を確認して反映'}
          </button>
        </div>
      )}
      {atFinalReviewStep && canSaveAppliedMappings && (
        <div className="mt-2 flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-blue-800">仮選択した{progress.staged.toLocaleString()}件を対応表へ保存します。過去の出力は変更せず、次回以降の取込から使用します。</p>
          <button
            type="button"
            onClick={requestFinalAction}
            disabled={savingMappingsImportId !== null || confirmingImportId !== null}
            className="shrink-0 rounded-full bg-text-primary px-5 py-2.5 text-sm font-semibold text-white disabled:bg-text-primary/40 disabled:cursor-not-allowed"
          >
            {savingMappingsImportId === selectedImport.import.id ? '対応表を保存中...' : '選択した対応をまとめて保存'}
          </button>
        </div>
      )}
    </>}
    {confirmationOpen && selectedImport && (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4" role="presentation">
        <section ref={confirmationDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="order-list-final-confirm-title" aria-describedby="order-list-final-confirm-description" className="w-full max-w-lg rounded-2xl border border-border-card bg-card-bg p-5 shadow-2xl sm:p-6">
          <h3 id="order-list-final-confirm-title" className="text-lg font-bold text-text-primary">未選択または入力エラーが残っています</h3>
          <div id="order-list-final-confirm-description" className="mt-3 space-y-2 text-sm leading-relaxed text-text-secondary">
            {(finalWarning ?? '').split('\n').filter(Boolean).map((line) => <p key={line}>{line}</p>)}
          </div>
          <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">残っている商品は今回{selectedImport.import.status === 'applied' ? '対応表へ保存されません' : '反映されません'}。</p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button ref={confirmationCancelRef} type="button" onClick={closeConfirmation} className="rounded-full border border-border-card px-4 py-2.5 text-sm font-semibold text-text-secondary hover:bg-warm-100">戻って確認</button>
            <button
              type="button"
              onClick={continueFinalAction}
              disabled={confirmDisabled || confirmingImportId !== null || savingMappingsImportId !== null}
              className="rounded-full bg-text-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-warm-800 disabled:opacity-40"
            >
              {selectedImport.import.status === 'applied' ? '残っている商品を除いて保存' : '残っている商品を除いて反映'}
            </button>
          </div>
        </section>
      </div>
    )}
  </div>;
}
