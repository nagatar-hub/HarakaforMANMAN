'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { CustomBuybackCatalogCard, CustomBuybackFranchise, CustomBuybackItemRow, CustomBuybackPageRow, CustomBuybackProductType, CustomBuybackSheetRow, CustomPagePlan, LayoutTemplateRow } from '@haraka/shared';
import { tokyoBusinessDate } from '@haraka/shared';
import { downloadImagesAsZip, downloadSingleImage } from '@/lib/download-images';
import { SortableBuybackCard, passthroughImageLoader } from './sortable-buyback-card';
import { DEFAULT_CATALOG_FILTERS, catalogSearchParams, customBuybackCsv, isCatalogPriceRangeValid, reorderCustomBuybackItems, safeDownloadName, type CatalogFilters } from './custom-buyback-state';

type SheetDetail = {
  sheet: CustomBuybackSheetRow;
  items: CustomBuybackItemRow[];
  pages: CustomBuybackPageRow[];
  layouts: LayoutTemplateRow[];
  preview: CustomPagePlan<LayoutTemplateRow>[] | null;
};
type CatalogResponse = { snapshot: { runId: string; businessDate: string; isCurrent: boolean }; cards: CustomBuybackCatalogCard[] };
type Flash = { type: 'success' | 'error' | 'info'; message: string };

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/custom-buyback/${path}`, {
    ...init,
    cache: 'no-store',
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '操作に失敗しました');
  return payload as T;
}

export function CustomBuybackClient({ initialSheetId }: { initialSheetId?: string }) {
  const [sheets, setSheets] = useState<CustomBuybackSheetRow[]>([]);
  const [detail, setDetail] = useState<SheetDetail | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogFilters, setCatalogFilters] = useState<CatalogFilters>(DEFAULT_CATALOG_FILTERS);
  const [catalogSelection, setCatalogSelection] = useState<Set<string>>(new Set());
  const [catalogKnownCards, setCatalogKnownCards] = useState<Map<string, CustomBuybackCatalogCard>>(new Map());
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogReturnFocus = useRef<HTMLElement | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [bulkOperation, setBulkOperation] = useState<'add' | 'percent' | 'round' | 'reset'>('add');
  const [bulkValue, setBulkValue] = useState(0);
  const [undoStack, setUndoStack] = useState<string[][]>([]);
  const [redoStack, setRedoStack] = useState<string[][]>([]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadSheets = useCallback(async (preferredId?: string) => {
    const rows = await apiJson<CustomBuybackSheetRow[]>('sheets');
    setSheets(rows);
    const target = preferredId ?? selectedSheetId ?? rows[0]?.id ?? null;
    setSelectedSheetId(target);
    return target;
  }, [selectedSheetId]);
  const loadDetail = useCallback(async (sheetId: string) => {
    const data = await apiJson<SheetDetail>(`sheets/${encodeURIComponent(sheetId)}`);
    setDetail(data);
    setSelectedItems((current) => new Set([...current].filter((id) => data.items.some((item) => item.id === id))));
    setSheets((current) => current.map((sheet) => sheet.id === data.sheet.id ? data.sheet : sheet));
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const target = await loadSheets(initialSheetId);
        if (active && target) await loadDetail(target);
      } catch (error) {
        if (active) setFlash({ type: 'error', message: messageOf(error) });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
    // Initial load only; selection is explicit afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!detail || detail.sheet.status !== 'rendering') return;
    const timer = window.setInterval(() => void loadDetail(detail.sheet.id).catch(showError), 3000);
    return () => window.clearInterval(timer);
  }, [detail?.sheet.id, detail?.sheet.status, loadDetail]);

  function showError(error: unknown) { setFlash({ type: 'error', message: messageOf(error) }); }
  async function selectSheet(id: string) {
    setSelectedSheetId(id); setLoading(true); setShowCatalog(false); setCatalog(null); setCatalogFilters(DEFAULT_CATALOG_FILTERS); setCatalogSelection(new Set()); setCatalogKnownCards(new Map()); setUndoStack([]); setRedoStack([]);
    try { await loadDetail(id); } catch (error) { showError(error); } finally { setLoading(false); }
  }
  function startNew() { setSelectedSheetId(null); setDetail(null); setShowCatalog(false); setCatalog(null); setCatalogFilters(DEFAULT_CATALOG_FILTERS); setCatalogSelection(new Set()); setCatalogKnownCards(new Map()); setFlash(null); }
  async function createSheet(input: { name: string; franchise: CustomBuybackFranchise; product_type: CustomBuybackProductType; kind: 'postal' | 'store'; display_date: string }) {
    setBusy('create');
    try {
      const created = await apiJson<CustomBuybackSheetRow>('sheets', { method: 'POST', body: JSON.stringify(input) });
      setCatalog(null); setCatalogFilters(DEFAULT_CATALOG_FILTERS); setCatalogSelection(new Set()); setCatalogKnownCards(new Map());
      await loadSheets(created.id); await loadDetail(created.id); setSelectedSheetId(created.id);
      setFlash({ type: 'success', message: '新しいカスタム買取表を作成しました' });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function updateDisplayDate(displayDate: string) {
    if (!detail || detail.sheet.display_date === displayDate) return;
    setBusy('display-date');
    try {
      const updated = await apiJson<CustomBuybackSheetRow>(`sheets/${detail.sheet.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ display_date: displayDate }),
      });
      setDetail((current) => current ? { ...current, sheet: updated } : current);
      setSheets((current) => current.map((sheet) => sheet.id === updated.id ? updated : sheet));
      setFlash({ type: 'success', message: '表の日付を変更しました。画像へ反映するには再生成してください。' });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  const searchCatalog = useCallback(async (filters: CatalogFilters, signal: AbortSignal) => {
    if (!detail) return;
    setCatalogLoading(true); setCatalogError(null);
    try {
      const params = catalogSearchParams(filters);
      params.set('franchise', detail.sheet.franchise); params.set('product_type', detail.sheet.product_type);
      const response = await apiJson<CatalogResponse>(`catalog?${params}`, { signal });
      setCatalog(response);
      setCatalogKnownCards((current) => {
        const next = new Map(current);
        response.cards.forEach((card) => next.set(catalogCardId(card), card));
        return next;
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setCatalogError(messageOf(error));
    } finally { if (!signal.aborted) setCatalogLoading(false); }
  }, [detail?.sheet.franchise, detail?.sheet.product_type]);
  useEffect(() => {
    if (!showCatalog) return;
    if (!isCatalogPriceRangeValid(catalogFilters)) { setCatalogLoading(false); setCatalogError(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void searchCatalog(catalogFilters, controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [showCatalog, catalogFilters, searchCatalog]);
  function openCatalog() { catalogReturnFocus.current = document.activeElement as HTMLElement | null; setShowCatalog(true); }
  const closeCatalog = useCallback(() => { setShowCatalog(false); window.setTimeout(() => catalogReturnFocus.current?.focus(), 0); }, []);
  async function addCatalogCards() {
    if (!detail || catalogSelection.size === 0) return;
    const count = catalogSelection.size; setBusy('add');
    try {
      await apiJson(`sheets/${detail.sheet.id}/items`, { method: 'POST', body: JSON.stringify({ catalog_ids: [...catalogSelection] }) });
      await loadDetail(detail.sheet.id); setCatalogSelection(new Set()); setShowCatalog(false);
      setFlash({ type: 'success', message: `${count}件を追加しました` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  function updateLocalValue(id: string, field: 'final_price_high' | 'demand', value: number | null) {
    setDetail((current) => current ? { ...current, items: current.items.map((item) => item.id === id ? { ...item, [field]: value } : item) } : current);
  }
  async function savePrice(itemId: string) {
    const item = detail?.items.find((row) => row.id === itemId);
    if (!detail || !item) return;
    try {
      const unchanged = item.final_price_high === item.source_price_high;
      const updated = await apiJson<CustomBuybackItemRow>(`sheets/${detail.sheet.id}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ final_price_high: item.final_price_high, demand: item.demand, override_reason: unchanged ? null : '画面で手修正' }),
      });
      setDetail((current) => current ? { ...current, items: current.items.map((row) => row.id === updated.id ? updated : row) } : current);
    } catch (error) { showError(error); await loadDetail(detail.sheet.id).catch(() => undefined); }
  }
  async function resetPrice(itemId: string) {
    if (!detail) return;
    setBusy(`price-${itemId}`);
    try {
      const updated = await apiJson<CustomBuybackItemRow>(`sheets/${detail.sheet.id}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ reset: true }) });
      setDetail((current) => current ? { ...current, items: current.items.map((row) => row.id === updated.id ? updated : row) } : current);
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function deleteItem(itemId: string) {
    if (!detail || !window.confirm('このカードを表から削除しますか？')) return;
    setBusy(`delete-${itemId}`);
    try { await apiJson(`sheets/${detail.sheet.id}/items/${itemId}`, { method: 'DELETE' }); await loadDetail(detail.sheet.id); }
    catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function persistOrder(targetIds: string[], rollbackIds: string[]): Promise<boolean> {
    if (!detail) return false;
    try {
      setDetail((current) => current ? { ...current, items: reorderCustomBuybackItems(current.items, targetIds) } : current);
      await apiJson(`sheets/${detail.sheet.id}/reorder`, { method: 'PUT', body: JSON.stringify({ item_ids: targetIds }) }); return true;
    } catch (error) {
      setDetail((current) => current ? { ...current, items: reorderCustomBuybackItems(current.items, rollbackIds) } : current); showError(error); return false;
    }
  }
  function onDragEnd(event: DragEndEvent) {
    if (!detail || !event.over || event.active.id === event.over.id) return;
    const currentIds = detail.items.map((item) => item.id);
    const oldIndex = currentIds.indexOf(String(event.active.id)); const newIndex = currentIds.indexOf(String(event.over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    setUndoStack((stack) => [...stack.slice(-19), currentIds]); setRedoStack([]);
    void persistOrder(arrayMove(currentIds, oldIndex, newIndex), currentIds);
  }
  async function undo() {
    if (!detail || undoStack.length === 0) return;
    const target = undoStack.at(-1)!; const current = detail.items.map((item) => item.id);
    if (await persistOrder(target, current)) { setUndoStack((stack) => stack.slice(0, -1)); setRedoStack((stack) => [...stack, current]); }
  }
  async function redo() {
    if (!detail || redoStack.length === 0) return;
    const target = redoStack.at(-1)!; const current = detail.items.map((item) => item.id);
    if (await persistOrder(target, current)) { setRedoStack((stack) => stack.slice(0, -1)); setUndoStack((stack) => [...stack, current]); }
  }
  async function applyBulkPrice() {
    if (!detail || selectedItems.size === 0) return;
    setBusy('bulk');
    try {
      await apiJson(`sheets/${detail.sheet.id}/bulk-price`, { method: 'POST', body: JSON.stringify({ item_ids: [...selectedItems], operation: bulkOperation, value: bulkValue }) });
      await loadDetail(detail.sheet.id); setFlash({ type: 'success', message: `${selectedItems.size}件の価格を更新しました` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function cloneSheet() {
    if (!detail) return;
    const name = window.prompt('複製後の表名', `${detail.sheet.name} のコピー`); if (!name) return;
    setBusy('clone');
    try {
      const cloned = await apiJson<SheetDetail>(`sheets/${detail.sheet.id}/clone`, { method: 'POST', body: JSON.stringify({ name }) });
      setShowCatalog(false); setCatalog(null); setCatalogFilters(DEFAULT_CATALOG_FILTERS); setCatalogSelection(new Set()); setCatalogKnownCards(new Map());
      await loadSheets(cloned.sheet.id); setSelectedSheetId(cloned.sheet.id); setDetail(cloned);
      setFlash({ type: 'success', message: 'カード・価格・並び順をまとめて複製しました' });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function refreshPrices(preserveOverrides: boolean) {
    if (!detail) return;
    if (!preserveOverrides && !window.confirm('手修正価格もすべて当日のDB価格へ戻します。よろしいですか？')) return;
    setBusy('refresh');
    try {
      setDetail(await apiJson<SheetDetail>(`sheets/${detail.sheet.id}/refresh-prices`, { method: 'POST', body: JSON.stringify({ preserve_overrides: preserveOverrides }) }));
      const source = detail.sheet.catalog_source === 'kaitori_checker' ? '買取チェッカー価格' : '取得価格';
      setFlash({ type: 'success', message: preserveOverrides ? `手修正を維持して最新の${source}へ更新しました` : `すべて最新の${source}へ戻しました` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function renderSheet() {
    if (!detail) return;
    setBusy('render');
    try {
      await apiJson(`sheets/${detail.sheet.id}/render`, { method: 'POST', body: '{}' }); await loadDetail(detail.sheet.id);
      setFlash({ type: 'info', message: '専用レンダージョブを開始しました。完了まで自動更新します。' });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  async function deleteSheet() {
    if (!detail || !window.confirm(`「${detail.sheet.name}」を削除しますか？`)) return;
    setBusy('delete-sheet');
    try {
      await apiJson(`sheets/${detail.sheet.id}`, { method: 'DELETE' });
      const rows = await apiJson<CustomBuybackSheetRow[]>('sheets'); setSheets(rows); setDetail(null); setSelectedSheetId(null);
      if (rows[0]) await selectSheet(rows[0].id); setFlash({ type: 'success', message: 'カスタム買取表を削除しました' });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  function downloadCsv() {
    if (!detail) return;
    const blob = new Blob([customBuybackCsv(detail.items)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
    link.download = `${safeDownloadName(detail.sheet.name)}_商品明細.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  // A failed rerender deliberately keeps the last successful image URL.
  const generatedPages = detail?.pages.filter((page) => page.image_url) ?? [];
  const pageGroups = useMemo(() => {
    if (!detail?.preview) return [];
    let cursor = 0;
    return detail.preview.map((plan) => { const items = detail.items.slice(cursor, cursor + plan.layout.total_slots); cursor += plan.layout.total_slots; return { ...plan, items }; });
  }, [detail]);

  return (
    <div className="relative left-1/2 w-[calc(100vw-1.5rem)] max-w-[1720px] -translate-x-1/2 pb-10 sm:w-[calc(100vw-3rem)]">
      <header className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-accent">Custom Buyback Studio</p><h1 className="page-title text-3xl text-text-primary sm:text-5xl">カスタム買取表</h1><p className="mt-2 max-w-2xl text-sm text-text-secondary">取得した最高価格を起点に、必要な商品だけを選び、表示価格・募集数・配置を調整できます。</p></div>
        <div className="flex flex-wrap gap-2"><Link href="/gallery/custom" className="rounded-full border border-border-card bg-white px-5 py-2.5 text-sm font-bold hover:bg-warm-50">ギャラリーを見る</Link><button type="button" onClick={startNew} className="rounded-full bg-text-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-warm-800">＋ 新しい表</button></div>
      </header>
      {flash && <div role="status" className={`mb-5 flex justify-between rounded-xl border px-4 py-3 text-sm ${flash.type === 'error' ? 'border-red-300 bg-red-50 text-red-800' : flash.type === 'success' ? 'border-green-300 bg-green-50 text-green-800' : 'border-blue-300 bg-blue-50 text-blue-800'}`}><span>{flash.message}</span><button type="button" onClick={() => setFlash(null)} className="ml-3 font-bold">×</button></div>}
      <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-border-card bg-card-bg p-3 lg:sticky lg:top-5 lg:h-fit">
          <div className="mb-2 flex justify-between px-2"><h2 className="text-sm font-bold">保存した表</h2><span className="text-xs text-text-secondary">{sheets.length}</span></div>
          <div className="max-h-72 space-y-1 overflow-y-auto lg:max-h-[65vh]">
            {sheets.length === 0 ? <p className="px-2 py-6 text-center text-xs text-text-secondary">まだありません</p> : sheets.map((sheet) => <button key={sheet.id} type="button" onClick={() => void selectSheet(sheet.id)} className={`w-full rounded-xl px-3 py-2.5 text-left transition ${selectedSheetId === sheet.id ? 'bg-text-primary text-white' : 'hover:bg-white/60'}`}><span className="block truncate text-sm font-bold">{sheet.name}</span><span className={`mt-1 flex justify-between text-[10px] ${selectedSheetId === sheet.id ? 'text-white/70' : 'text-text-secondary'}`}><span>{sheet.display_date} · {sheet.product_type.toUpperCase()}</span><span>{statusLabel(sheet.status)}</span></span></button>)}
          </div>
        </aside>
        <section className="min-w-0">
          {loading ? <div className="rounded-2xl border border-border-card bg-card-bg p-12 text-center text-text-secondary">読み込み中...</div> : !detail ? <CreateSheetPanel busy={busy === 'create'} onCreate={createSheet} /> : <div className="space-y-5">
            <SheetToolbar detail={detail} busy={busy} generatedCount={generatedPages.length} onDisplayDateChange={(value) => void updateDisplayDate(value)} onAdd={openCatalog} onClone={() => void cloneSheet()} onRefresh={() => void refreshPrices(true)} onResetRefresh={() => void refreshPrices(false)} onRender={() => void renderSheet()} onCsv={downloadCsv} onZip={() => void downloadImagesAsZip(generatedPages.map((page) => ({ image_url: page.image_url!, filename: `${safeDownloadName(detail.sheet.name)}_${String(page.page_index + 1).padStart(2, '0')}.png` })), `${safeDownloadName(detail.sheet.name)}.zip`)} onDelete={() => void deleteSheet()} />
            {showCatalog && createPortal(<CatalogPanel catalogSource={detail.sheet.catalog_source} productType={detail.sheet.product_type} filters={catalogFilters} setFilters={setCatalogFilters} result={catalog} knownCards={catalogKnownCards} selection={catalogSelection} loading={catalogLoading} error={catalogError} busy={busy} existingSourceIds={new Set(detail.items.map((item) => item.source_kaitori_product_id == null ? item.source_prepared_card_id : String(item.source_kaitori_product_id)).filter((id): id is string => Boolean(id)))} onToggle={(id) => setCatalogSelection((current) => toggleSet(current, id))} onSelectVisible={(ids) => setCatalogSelection((current) => new Set([...current, ...ids]))} onClearSelection={() => setCatalogSelection(new Set())} onAdd={() => void addCatalogCards()} onClose={closeCatalog} />, document.body)}
            {detail.sheet.price_business_date !== tokyoBusinessDate() && <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">この表の価格基準日は {detail.sheet.price_business_date} です。「最新価格へ更新」で最新化できます。</div>}
            {detail.items.length === 0 ? <button type="button" onClick={openCatalog} className="flex min-h-72 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-warm-300 bg-card-bg/50 hover:border-accent hover:bg-accent-light"><span className="text-4xl">＋</span><strong className="mt-2">商品を追加</strong><span className="mt-1 text-sm text-text-secondary">商品カタログから複数選択できます</span></button> : <>
              <BulkToolbar locked={detail.sheet.status === 'rendering'} selected={selectedItems.size} total={detail.items.length} operation={bulkOperation} value={bulkValue} busy={busy === 'bulk'} undoCount={undoStack.length} redoCount={redoStack.length} setOperation={setBulkOperation} setValue={setBulkValue} onSelectAll={() => setSelectedItems(selectedItems.size === detail.items.length ? new Set() : new Set(detail.items.map((item) => item.id)))} onClearSelection={() => setSelectedItems(new Set())} onApply={() => void applyBulkPrice()} onUndo={() => void undo()} onRedo={() => void redo()} />
              {!detail.preview ? <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">このタイトル・用途で利用できるレイアウトがありません。</div> : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={detail.items.map((item) => item.id)} strategy={rectSortingStrategy}><div className="space-y-5">{pageGroups.map((page) => <section key={page.pageIndex} className="rounded-2xl border border-border-card bg-card-bg p-3 sm:p-5"><div className="mb-3 flex items-center justify-between"><div><h3 className="font-bold">ページ {page.pageIndex + 1}</h3><p className="text-[11px] text-text-secondary">{page.layout.slug} · {page.items.length}/{page.layout.total_slots}枠</p></div>{pageButton(detail, generatedPages, page.pageIndex)}</div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{page.items.map((item) => <SortableBuybackCard key={item.id} item={item} productType={detail.sheet.product_type} selected={selectedItems.has(item.id)} disabled={detail.sheet.status === 'rendering'} onToggle={(id) => setSelectedItems((current) => toggleSet(current, id))} onValueChange={updateLocalValue} onSave={(changed) => void savePrice(changed.id)} onResetPrice={(id) => void resetPrice(id)} onDelete={(id) => void deleteItem(id)} />)}</div></section>)}</div></SortableContext></DndContext>}
            </>}
            {generatedPages.length > 0 && <GeneratedPreview detail={detail} pages={generatedPages} />}
          </div>}
        </section>
      </div>
    </div>
  );
}

function CreateSheetPanel({ busy, onCreate }: {
  busy: boolean;
  onCreate: (input: { name: string; franchise: CustomBuybackFranchise; product_type: CustomBuybackProductType; kind: 'postal' | 'store'; display_date: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [displayDate, setDisplayDate] = useState(tokyoBusinessDate());
  const [franchise, setFranchise] = useState<CustomBuybackFranchise>('Pokemon');
  const [productType, setProductType] = useState<CustomBuybackProductType>('psa');
  const [kind, setKind] = useState<'postal' | 'store'>('store');
  return <form onSubmit={(event) => { event.preventDefault(); void onCreate({ name, franchise, product_type: productType, kind, display_date: displayDate }); }} className="rounded-2xl border border-border-card bg-card-bg p-5 sm:p-8">
    <div className="mb-7"><span className="text-xs font-bold text-accent">STEP 1</span><h2 className="mt-1 text-2xl font-bold">表の種類を選ぶ</h2><p className="mt-1 text-sm text-text-secondary">作成後にカードを検索して追加します。</p></div>
    <label className="mb-5 block"><span className="mb-2 block text-sm font-bold">表の名前</span><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="例：8月3日 ポケモンPSA強化" className="w-full rounded-xl border border-border-card bg-white px-4 py-3 outline-none focus:border-accent" /></label>
    <label className="mb-5 block"><span className="mb-2 block text-sm font-bold">表に表示する日付</span><input required type="date" value={displayDate} onChange={(event) => setDisplayDate(event.target.value)} className="w-full rounded-xl border border-border-card bg-white px-4 py-3 outline-none focus:border-accent sm:max-w-xs" /><span className="mt-1.5 block text-xs text-text-secondary">画像へ印字され、カスタムギャラリーもこの日付で整理されます。作成後も変更できます。</span></label>
    <fieldset className="mb-5"><legend className="mb-2 text-sm font-bold">カードタイトル</legend><div className="grid gap-2 sm:grid-cols-3">{(['Pokemon', 'ONE PIECE', 'YU-GI-OH!'] as const).map((value) => <Choice key={value} selected={franchise === value} onClick={() => setFranchise(value)}>{value}</Choice>)}</div></fieldset>
    <fieldset className="mb-5"><legend className="mb-2 text-sm font-bold">商品タイプ</legend><div className="grid grid-cols-2 gap-2"><Choice selected={productType === 'psa'} onClick={() => setProductType('psa')}><strong>PSA</strong><small>表示価格＋募集枚数</small></Choice><Choice selected={productType === 'box'} onClick={() => setProductType('box')}><strong>BOX</strong><small>表示価格＋募集個数</small></Choice></div></fieldset>
    <fieldset className="mb-7"><legend className="mb-2 text-sm font-bold">用途</legend><div className="grid grid-cols-2 gap-2"><Choice selected={kind === 'store'} onClick={() => setKind('store')}>店頭用</Choice><Choice selected={kind === 'postal'} onClick={() => setKind('postal')}>郵送用</Choice></div></fieldset>
    <button disabled={busy || !name.trim()} className="w-full rounded-xl bg-text-primary px-5 py-3.5 font-bold text-white disabled:opacity-40">{busy ? '作成中...' : 'この内容で作成 →'}</button>
  </form>;
}

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`flex min-h-16 flex-col items-center justify-center rounded-xl border px-3 py-2 text-sm transition ${selected ? 'border-accent bg-accent-light text-accent ring-1 ring-accent' : 'border-border-card bg-white hover:border-warm-400'}`}>{children}</button>;
}

function SheetToolbar({ detail, busy, generatedCount, onDisplayDateChange, onAdd, onClone, onRefresh, onResetRefresh, onRender, onCsv, onZip, onDelete }: {
  detail: SheetDetail; busy: string | null; generatedCount: number;
  onDisplayDateChange: (value: string) => void; onAdd: () => void; onClone: () => void; onRefresh: () => void; onResetRefresh: () => void; onRender: () => void; onCsv: () => void; onZip: () => void; onDelete: () => void;
}) {
  const rendering = detail.sheet.status === 'rendering';
  return <section className="rounded-2xl border border-border-card bg-card-bg p-4 sm:p-6"><div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-2xl font-bold">{detail.sheet.name}</h2><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${rendering ? 'bg-blue-100 text-blue-700' : detail.sheet.status === 'ready' ? 'bg-green-100 text-green-700' : detail.sheet.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-warm-100 text-warm-700'}`}>{statusLabel(detail.sheet.status)}</span></div><p className="mt-1 text-xs text-text-secondary">{detail.sheet.franchise} · {detail.sheet.product_type.toUpperCase()} · {detail.sheet.kind === 'store' ? '店頭用' : '郵送用'} · {detail.items.length}件</p><div className="mt-3 flex flex-wrap items-end gap-3"><label className="text-xs font-bold"><span className="mb-1 block text-text-secondary">表の日付</span><input aria-label="表の日付" type="date" value={detail.sheet.display_date} disabled={rendering || busy === 'display-date'} onChange={(event) => onDisplayDateChange(event.target.value)} className="rounded-lg border border-border-card bg-white px-3 py-2 font-normal disabled:opacity-50" /></label><p className="pb-2 text-[11px] text-text-secondary">作成日時 {formatCreatedAt(detail.sheet.created_at)}<br />価格基準日 {detail.sheet.price_business_date}</p></div>{detail.sheet.error_message && <p className="mt-2 text-xs text-red-700">{detail.sheet.error_message}</p>}</div>
    <div className="flex flex-wrap gap-2"><button type="button" onClick={onAdd} disabled={rendering} className="rounded-full bg-text-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-40">＋ 商品追加</button><button type="button" onClick={onRender} disabled={rendering || detail.items.length === 0 || busy === 'render'} className="rounded-full bg-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-40">{rendering ? '生成中...' : '画像を生成'}</button><ActionMenu label="その他"><button type="button" disabled={rendering} onClick={onRefresh}>手修正を維持して最新の{detail.sheet.catalog_source === 'kaitori_checker' ? '買取チェッカー価格' : '取得価格'}へ更新</button><button type="button" disabled={rendering} onClick={onResetRefresh}>手修正も最新の{detail.sheet.catalog_source === 'kaitori_checker' ? '買取チェッカー価格' : '取得価格'}へ戻す</button><button type="button" onClick={onClone}>この表を複製</button><button type="button" onClick={onCsv}>商品明細CSV</button><button type="button" onClick={onZip} disabled={generatedCount === 0}>生成画像をZIP保存</button><button type="button" disabled={rendering} onClick={onDelete} className="!text-red-700">表を削除</button></ActionMenu></div>
  </div></section>;
}

function ActionMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="relative"><summary className="cursor-pointer list-none rounded-full border border-border-card bg-white px-4 py-2 text-xs font-bold">{label} ▾</summary><div className="absolute right-0 z-40 mt-2 flex w-64 flex-col rounded-xl border border-border-card bg-white p-1.5 shadow-xl [&>button]:rounded-lg [&>button]:px-3 [&>button]:py-2.5 [&>button]:text-left [&>button]:text-xs [&>button]:font-semibold [&>button]:text-text-primary [&>button:hover]:bg-warm-100 [&>button:disabled]:opacity-40">{children}</div></details>;
}

function CatalogPanel({ catalogSource, productType, filters, setFilters, result, knownCards, selection, loading, error, busy, existingSourceIds, onToggle, onSelectVisible, onClearSelection, onAdd, onClose }: {
  catalogSource: CustomBuybackSheetRow['catalog_source']; productType: CustomBuybackProductType; filters: CatalogFilters; setFilters: React.Dispatch<React.SetStateAction<CatalogFilters>>; result: CatalogResponse | null; knownCards: Map<string, CustomBuybackCatalogCard>; selection: Set<string>; loading: boolean; error: string | null; busy: string | null; existingSourceIds: Set<string>; onToggle: (id: string) => void; onSelectVisible: (ids: string[]) => void; onClearSelection: () => void; onAdd: () => void; onClose: () => void;
}) {
  const [hideExisting, setHideExisting] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [preview, setPreview] = useState<CustomBuybackCatalogCard | null>(null);
  const previewRef = useRef<CustomBuybackCatalogCard | null>(null);
  const previewDialog = useRef<HTMLDivElement>(null);
  const previewClose = useRef<HTMLButtonElement>(null);
  const previewReturnFocus = useRef<HTMLButtonElement>(null);
  const dialogRoot = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const priceRangeValid = isCatalogPriceRangeValid(filters);
  previewRef.current = preview;
  const visibleCards = (selectedOnly ? [...knownCards.values()].filter((card) => selection.has(catalogCardId(card))) : result?.cards ?? []).filter((card) => {
    const id = catalogCardId(card);
    return (!hideExisting || !existingSourceIds.has(id)) && (!selectedOnly || selection.has(id));
  });
  const selectableVisibleIds = visibleCards.map(catalogCardId).filter((id) => !existingSourceIds.has(id) && !selection.has(id));
  const closePreview = useCallback(() => {
    setPreview(null);
    queueMicrotask(() => previewReturnFocus.current?.focus());
  }, []);

  useEffect(() => { if (preview) previewClose.current?.focus(); }, [preview]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    searchInput.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (previewRef.current) closePreview(); else onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...((previewRef.current ? previewDialog.current : dialogRoot.current)?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])') ?? [])];
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKeyDown); };
  }, [closePreview, onClose]);

  return <div ref={dialogRoot} className="fixed inset-0 z-[60] bg-black/55 p-2 sm:p-4" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="catalog-title" className="mx-auto flex h-[calc(100dvh-1rem)] max-w-[1680px] flex-col overflow-hidden border border-warm-300 bg-warm-50 shadow-2xl sm:h-[calc(100dvh-2rem)] sm:rounded-2xl">
      <header className="shrink-0 border-b border-border-card bg-warm-50 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start justify-between gap-4"><div><h2 id="catalog-title" className="text-lg font-bold sm:text-2xl">{catalogSource === 'kaitori_checker' ? '買取チェッカー' : '商品カタログ'}から{productType.toUpperCase()}を追加</h2><p className="mt-1 text-xs text-text-secondary sm:text-sm">条件を変えると自動で更新します。最高買取価格がある商品を最大100件表示します。</p></div><button type="button" onClick={onClose} aria-label="商品選択を閉じる" className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border-card bg-white text-2xl leading-none hover:bg-warm-100 focus-visible:outline-2 focus-visible:outline-accent">×</button></div>
        <div className="mt-4 grid gap-2 md:grid-cols-[minmax(18rem,2fr)_minmax(8rem,0.7fr)_minmax(8rem,0.7fr)_minmax(11rem,0.9fr)_auto]">
          <label><span className="sr-only">商品名・型番・レアリティ・店舗名</span><input ref={searchInput} type="search" value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} placeholder="商品名・型番・レアリティ・店舗名" className="h-11 w-full rounded-lg border border-border-card bg-white px-3 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent" /></label>
          <label><span className="sr-only">最低価格</span><input type="number" min="0" max="100000000" inputMode="numeric" value={filters.minPrice} onChange={(event) => setFilters((current) => ({ ...current, minPrice: event.target.value }))} placeholder="最低価格" className="h-11 w-full rounded-lg border border-border-card bg-white px-3 text-sm outline-none focus:border-accent" /></label>
          <label><span className="sr-only">最高価格</span><input type="number" min="0" max="100000000" inputMode="numeric" value={filters.maxPrice} onChange={(event) => setFilters((current) => ({ ...current, maxPrice: event.target.value }))} placeholder="最高価格" className="h-11 w-full rounded-lg border border-border-card bg-white px-3 text-sm outline-none focus:border-accent" /></label>
          <label><span className="sr-only">並び替え</span><select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as CatalogFilters['sort'] }))} className="h-11 w-full rounded-lg border border-border-card bg-white px-3 text-sm outline-none focus:border-accent"><option value="price_desc">価格が高い順</option><option value="price_asc">価格が安い順</option><option value="name_asc">商品名順</option></select></label>
          <button type="button" onClick={() => { setFilters(DEFAULT_CATALOG_FILTERS); setHideExisting(true); setSelectedOnly(false); }} className="h-11 rounded-lg border border-border-card bg-white px-4 text-sm font-bold hover:bg-warm-100">条件をリセット</button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={hideExisting} onChange={(event) => setHideExisting(event.target.checked)} className="h-4 w-4 accent-accent" />未追加のみ</label>
          <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} className="h-4 w-4 accent-accent" />選択中のみ</label>
          <span aria-live="polite" className="ml-auto text-xs text-text-secondary">{loading ? '検索中…' : `${visibleCards.length}件表示${result ? ` / ${result.cards.length}件` : ''}`}</span>
        </div>
        {!priceRangeValid && <p role="alert" className="mt-2 text-sm font-bold text-red-700">価格は0〜100,000,000円の整数で、最低価格が最高価格以下になるよう入力してください。</p>}
        {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {result && !result.snapshot.isCurrent && <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900">価格基準日: {result.snapshot.businessDate}（最新取得分）</p>}
        {result?.cards.length === 100 && !selectedOnly && <p className="mt-2 text-xs text-text-secondary">表示上限の100件です。検索・価格帯で絞り込むと、ほかの商品も探せます。</p>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6" aria-busy={loading}>
        {visibleCards.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{visibleCards.map((card) => {
          const id = catalogCardId(card); const existing = existingSourceIds.has(id); const selected = selection.has(id); const imageUrl = card.image_url || card.alt_image_url;
          return <article key={id} className={`flex min-h-40 gap-3 border bg-white p-3 ${selected ? 'border-accent ring-2 ring-accent/20' : 'border-border-card'} ${existing ? 'opacity-55' : ''}`}>
            <button type="button" disabled={!imageUrl} onClick={(event) => { previewReturnFocus.current = event.currentTarget; setPreview(card); }} aria-label={`${card.card_name}の画像を拡大`} className="relative h-36 w-24 shrink-0 overflow-hidden rounded-md bg-warm-100 disabled:cursor-default">{imageUrl ? <Image loader={passthroughImageLoader} unoptimized fill sizes="96px" src={imageUrl} alt="" className="object-contain" /> : <span className="grid h-full place-items-center px-2 text-center text-xs text-text-secondary">画像なし</span>}</button>
            <button type="button" disabled={existing} aria-pressed={selected} onClick={() => onToggle(id)} className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed">
              <span className="line-clamp-3 text-sm font-bold leading-5">{card.card_name}</span>
              <span className="mt-2 block text-xs leading-5 text-text-secondary">{productType.toUpperCase()}<br />{[card.grade, card.list_no, card.rarity].filter(Boolean).join(' · ') || '型番・レアリティ不明'}</span>
              <span className="mt-2 block text-lg font-black text-accent">¥{card.price_high?.toLocaleString()}</span>
              <span className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">{card.shop_name ?? '店舗不明'} · {card.condition_name ?? '状態不明'}</span>
              <span className={`mt-2 inline-flex items-center gap-1 text-xs font-bold ${selected ? 'text-accent' : 'text-text-secondary'}`}><span aria-hidden="true">{existing ? '済' : selected ? '✓' : '□'}</span>{existing ? '追加済み' : selected ? '選択中' : '選択する'}</span>
            </button>
          </article>;
        })}</div>}
        {!loading && priceRangeValid && result && visibleCards.length === 0 && <div className="grid min-h-64 place-items-center text-center"><div><p className="font-bold">該当商品がありません</p><p className="mt-1 text-sm text-text-secondary">検索条件を変更してください。</p></div></div>}
        {loading && !result && <div className="grid min-h-64 place-items-center text-sm text-text-secondary">商品を読み込んでいます…</div>}
      </div>

      <footer className="shrink-0 border-t border-border-card bg-white px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3"><strong className="mr-auto text-sm sm:text-base">{selection.size}件選択</strong><button type="button" onClick={() => onSelectVisible(selectableVisibleIds)} disabled={selectableVisibleIds.length === 0} className="rounded-lg border border-border-card px-3 py-2 text-xs font-bold hover:bg-warm-50 disabled:opacity-40">表示中をすべて選択</button><button type="button" onClick={onClearSelection} disabled={selection.size === 0} className="rounded-lg border border-border-card px-3 py-2 text-xs font-bold hover:bg-warm-50 disabled:opacity-40">選択を解除</button><button type="button" onClick={onAdd} disabled={selection.size === 0 || busy === 'add'} className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy === 'add' ? '追加中…' : `選択した${selection.size}件を追加`}</button></div>
      </footer>
    </section>
    {preview && <div ref={previewDialog} className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-6" role="dialog" aria-modal="true" aria-label={`${preview.card_name}の画像プレビュー`} onClick={closePreview}><button ref={previewClose} type="button" onClick={closePreview} aria-label="画像プレビューを閉じる" className="absolute right-5 top-5 grid h-11 w-11 place-items-center rounded-full bg-white text-2xl">×</button><div className="relative h-[82dvh] w-[min(90vw,42rem)]" onClick={(event) => event.stopPropagation()}>{(preview.image_url || preview.alt_image_url) && <Image loader={passthroughImageLoader} unoptimized fill sizes="90vw" src={(preview.image_url || preview.alt_image_url)!} alt={preview.card_name} className="object-contain" />}</div></div>}
  </div>;
}

function BulkToolbar({ locked, selected, total, operation, value, busy, undoCount, redoCount, setOperation, setValue, onSelectAll, onClearSelection, onApply, onUndo, onRedo }: {
  locked: boolean; selected: number; total: number; operation: 'add' | 'percent' | 'round' | 'reset'; value: number; busy: boolean; undoCount: number; redoCount: number;
  setOperation: (value: 'add' | 'percent' | 'round' | 'reset') => void; setValue: (value: number) => void; onSelectAll: () => void; onClearSelection: () => void; onApply: () => void; onUndo: () => void; onRedo: () => void;
}) {
  return <div className="flex flex-col gap-3 rounded-xl border border-border-card bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={locked} onClick={onSelectAll} className="rounded-lg border border-border-card px-3 py-2 text-xs font-bold disabled:opacity-30">{selected === total ? '全選択解除' : '全選択'}</button><button type="button" disabled={locked || selected === 0} onClick={onClearSelection} className="rounded-lg border border-border-card px-3 py-2 text-xs font-bold disabled:opacity-30">選択を解除</button><span className="text-xs text-text-secondary">{selected}/{total}件</span><button type="button" onClick={onUndo} disabled={locked || !undoCount} className="rounded-lg px-2 py-2 text-xs font-bold disabled:opacity-30">↶ Undo</button><button type="button" onClick={onRedo} disabled={locked || !redoCount} className="rounded-lg px-2 py-2 text-xs font-bold disabled:opacity-30">↷ Redo</button></div>
    <div className="flex flex-wrap items-center gap-2"><select disabled={locked} value={operation} onChange={(event) => setOperation(event.target.value as typeof operation)} className="rounded-lg border border-border-card px-2 py-2 text-xs"><option value="add">一律 加減算</option><option value="percent">一律 ％調整</option><option value="round">指定単位で丸め</option><option value="reset">元価格に戻す</option></select>{operation !== 'reset' && <input disabled={locked} type="number" value={value} onChange={(event) => setValue(Number(event.target.value))} className="w-24 rounded-lg border border-border-card px-2 py-2 text-right text-xs" />}<button type="button" onClick={onApply} disabled={locked || selected === 0 || busy} className="rounded-lg bg-text-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? '更新中' : '選択へ適用'}</button></div>
  </div>;
}

function GeneratedPreview({ detail, pages }: { detail: SheetDetail; pages: CustomBuybackPageRow[] }) {
  return <section className="rounded-2xl border border-border-card bg-card-bg p-4 sm:p-6"><h2 className="mb-4 text-lg font-bold">生成プレビュー</h2><div className="grid gap-4 md:grid-cols-2">{pages.map((page) => <div key={page.id} className="overflow-hidden rounded-xl border border-border-card bg-white"><div className="relative aspect-[4/3] bg-warm-100"><Image loader={passthroughImageLoader} unoptimized fill sizes="(max-width: 768px) 100vw, 50vw" src={page.image_url!} alt={`${detail.sheet.name} ページ${page.page_index + 1}`} className="object-contain" /></div><div className="flex items-center justify-between p-3 text-xs"><span>ページ {page.page_index + 1}</span><button type="button" onClick={() => void downloadSingleImage(page.image_url!, `${safeDownloadName(detail.sheet.name)}_${String(page.page_index + 1).padStart(2, '0')}.png`)} className="font-bold text-accent hover:underline">PNG保存</button></div></div>)}</div></section>;
}

function pageButton(detail: SheetDetail, pages: CustomBuybackPageRow[], pageIndex: number) {
  const page = pages.find((candidate) => candidate.page_index === pageIndex);
  if (!page?.image_url) return null;
  return <button type="button" onClick={() => void downloadSingleImage(page.image_url!, `${safeDownloadName(detail.sheet.name)}_${String(pageIndex + 1).padStart(2, '0')}.png`)} className="rounded-full border border-border-card bg-white px-3 py-1.5 text-xs font-bold hover:bg-warm-50">PNG保存</button>;
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next;
}

function catalogCardId(card: CustomBuybackCatalogCard): string {
  return card.source_product_id == null ? card.id : String(card.source_product_id);
}

function statusLabel(status: CustomBuybackSheetRow['status']): string {
  return ({ draft: '編集中', rendering: '画像生成中', ready: '生成済み', failed: '要確認' } as const)[status];
}

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
