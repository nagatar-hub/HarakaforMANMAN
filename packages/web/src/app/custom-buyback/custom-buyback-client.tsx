'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { CustomBuybackCatalogCard, CustomBuybackFranchise, CustomBuybackItemRow, CustomBuybackPageRow, CustomBuybackProductType, CustomBuybackSheetRow, CustomPagePlan, LayoutTemplateRow } from '@haraka/shared';
import { tokyoBusinessDate } from '@haraka/shared';
import { downloadImagesAsZip, downloadSingleImage } from '@/lib/download-images';
import { SortableBuybackCard, passthroughImageLoader } from './sortable-buyback-card';
import { customBuybackCsv, reorderCustomBuybackItems, safeDownloadName } from './custom-buyback-state';

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
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSelection, setCatalogSelection] = useState<Set<string>>(new Set());
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
    setSelectedSheetId(id); setLoading(true); setShowCatalog(false); setCatalog(null); setCatalogSelection(new Set()); setUndoStack([]); setRedoStack([]);
    try { await loadDetail(id); } catch (error) { showError(error); } finally { setLoading(false); }
  }
  function startNew() { setSelectedSheetId(null); setDetail(null); setShowCatalog(false); setCatalog(null); setCatalogSelection(new Set()); setFlash(null); }
  async function createSheet(input: { name: string; franchise: CustomBuybackFranchise; product_type: CustomBuybackProductType; kind: 'postal' | 'store'; display_date: string }) {
    setBusy('create');
    try {
      const created = await apiJson<CustomBuybackSheetRow>('sheets', { method: 'POST', body: JSON.stringify(input) });
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
  async function searchCatalog() {
    if (!detail) return;
    setBusy('catalog');
    try {
      const params = new URLSearchParams({ franchise: detail.sheet.franchise, product_type: detail.sheet.product_type, q: catalogQuery });
      setCatalog(await apiJson<CatalogResponse>(`catalog?${params}`)); setCatalogSelection(new Set());
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  function openCatalog() { setShowCatalog(true); if (!catalog) void searchCatalog(); }
  async function addCatalogCards() {
    if (!detail || catalogSelection.size === 0) return;
    const count = catalogSelection.size; setBusy('add');
    try {
      await apiJson(`sheets/${detail.sheet.id}/items`, { method: 'POST', body: JSON.stringify({ prepared_card_ids: [...catalogSelection] }) });
      await loadDetail(detail.sheet.id); setCatalogSelection(new Set()); setShowCatalog(false);
      setFlash({ type: 'success', message: `${count}件を追加しました` });
    } catch (error) { showError(error); } finally { setBusy(null); }
  }
  function updateLocalPrice(id: string, field: 'final_price_high' | 'final_price_low', value: number | null) {
    setDetail((current) => current ? { ...current, items: current.items.map((item) => item.id === id ? { ...item, [field]: value } : item) } : current);
  }
  async function savePrice(itemId: string) {
    const item = detail?.items.find((row) => row.id === itemId);
    if (!detail || !item) return;
    try {
      const unchanged = item.final_price_high === item.source_price_high
        && (detail.sheet.product_type === 'box' || item.final_price_low === item.source_price_low);
      const updated = await apiJson<CustomBuybackItemRow>(`sheets/${detail.sheet.id}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(unchanged ? { reset: true } : { final_price_high: item.final_price_high, final_price_low: item.final_price_low, override_reason: '画面で手修正' }),
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
      setFlash({ type: 'success', message: preserveOverrides ? '手修正を維持して当日価格へ更新しました' : 'すべて当日のDB価格へ更新しました' });
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
    <div className="pb-10">
      <header className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-accent">Custom Buyback Studio</p><h1 className="page-title text-3xl text-text-primary sm:text-5xl">カスタム買取表</h1><p className="mt-2 max-w-2xl text-sm text-text-secondary">当日の価格を起点に、必要なカードだけを選び、価格と配置を自由に調整できます。</p></div>
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
            {showCatalog && <CatalogPanel productType={detail.sheet.product_type} query={catalogQuery} setQuery={setCatalogQuery} result={catalog} selection={catalogSelection} busy={busy} existingSourceIds={new Set(detail.items.map((item) => item.source_prepared_card_id).filter((id): id is string => Boolean(id)))} onSearch={() => void searchCatalog()} onToggle={(id) => setCatalogSelection((current) => toggleSet(current, id))} onAdd={() => void addCatalogCards()} onClose={() => setShowCatalog(false)} />}
            {detail.sheet.price_business_date !== tokyoBusinessDate() && <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">この表の価格基準日は {detail.sheet.price_business_date} です。「当日価格へ更新」で最新化できます。</div>}
            {detail.items.length === 0 ? <button type="button" onClick={openCatalog} className="flex min-h-72 w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-warm-300 bg-card-bg/50 hover:border-accent hover:bg-accent-light"><span className="text-4xl">＋</span><strong className="mt-2">カードを追加</strong><span className="mt-1 text-sm text-text-secondary">当日のデータベースから複数選択できます</span></button> : <>
              <BulkToolbar locked={detail.sheet.status === 'rendering'} selected={selectedItems.size} total={detail.items.length} operation={bulkOperation} value={bulkValue} busy={busy === 'bulk'} undoCount={undoStack.length} redoCount={redoStack.length} setOperation={setBulkOperation} setValue={setBulkValue} onSelectAll={() => setSelectedItems(selectedItems.size === detail.items.length ? new Set() : new Set(detail.items.map((item) => item.id)))} onApply={() => void applyBulkPrice()} onUndo={() => void undo()} onRedo={() => void redo()} />
              {!detail.preview ? <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">このタイトル・用途で利用できるレイアウトがありません。</div> : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={detail.items.map((item) => item.id)} strategy={rectSortingStrategy}><div className="space-y-5">{pageGroups.map((page) => <section key={page.pageIndex} className="rounded-2xl border border-border-card bg-card-bg p-3 sm:p-5"><div className="mb-3 flex items-center justify-between"><div><h3 className="font-bold">ページ {page.pageIndex + 1}</h3><p className="text-[11px] text-text-secondary">{page.layout.slug} · {page.items.length}/{page.layout.total_slots}枠</p></div>{pageButton(detail, generatedPages, page.pageIndex)}</div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{page.items.map((item) => <SortableBuybackCard key={item.id} item={item} productType={detail.sheet.product_type} selected={selectedItems.has(item.id)} disabled={detail.sheet.status === 'rendering'} onToggle={(id) => setSelectedItems((current) => toggleSet(current, id))} onPriceChange={updateLocalPrice} onSavePrice={(changed) => void savePrice(changed.id)} onResetPrice={(id) => void resetPrice(id)} onDelete={(id) => void deleteItem(id)} />)}</div></section>)}</div></SortableContext></DndContext>}
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
    <fieldset className="mb-5"><legend className="mb-2 text-sm font-bold">商品タイプ</legend><div className="grid grid-cols-2 gap-2"><Choice selected={productType === 'psa'} onClick={() => setProductType('psa')}><strong>PSA</strong><small>上下2つの買取価格</small></Choice><Choice selected={productType === 'box'} onClick={() => setProductType('box')}><strong>BOX</strong><small>BOX専用レイアウト</small></Choice></div></fieldset>
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
    <div className="flex flex-wrap gap-2"><button type="button" onClick={onAdd} disabled={rendering} className="rounded-full bg-text-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-40">＋ カード追加</button><button type="button" onClick={onRender} disabled={rendering || detail.items.length === 0 || busy === 'render'} className="rounded-full bg-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-40">{rendering ? '生成中...' : '画像を生成'}</button><ActionMenu label="その他"><button type="button" disabled={rendering} onClick={onRefresh}>手修正を維持して当日価格へ更新</button><button type="button" disabled={rendering} onClick={onResetRefresh}>手修正も当日価格へ戻す</button><button type="button" onClick={onClone}>この表を複製</button><button type="button" onClick={onCsv}>商品明細CSV</button><button type="button" onClick={onZip} disabled={generatedCount === 0}>生成画像をZIP保存</button><button type="button" disabled={rendering} onClick={onDelete} className="!text-red-700">表を削除</button></ActionMenu></div>
  </div></section>;
}

function ActionMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="relative"><summary className="cursor-pointer list-none rounded-full border border-border-card bg-white px-4 py-2 text-xs font-bold">{label} ▾</summary><div className="absolute right-0 z-40 mt-2 flex w-64 flex-col rounded-xl border border-border-card bg-white p-1.5 shadow-xl [&>button]:rounded-lg [&>button]:px-3 [&>button]:py-2.5 [&>button]:text-left [&>button]:text-xs [&>button]:font-semibold [&>button]:text-text-primary [&>button:hover]:bg-warm-100 [&>button:disabled]:opacity-40">{children}</div></details>;
}

function CatalogPanel({ productType, query, setQuery, result, selection, busy, existingSourceIds, onSearch, onToggle, onAdd, onClose }: {
  productType: CustomBuybackProductType; query: string; setQuery: (value: string) => void; result: CatalogResponse | null; selection: Set<string>; busy: string | null; existingSourceIds: Set<string>; onSearch: () => void; onToggle: (id: string) => void; onAdd: () => void; onClose: () => void;
}) {
  return <section className="rounded-2xl border-2 border-accent/40 bg-accent-light p-4 sm:p-6">
    <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-bold">{productType.toUpperCase()}を検索して追加</h2><p className="text-xs text-text-secondary">当日価格が有効な商品だけを表示します（最大100件）</p></div><button type="button" onClick={onClose} className="rounded-full p-2 text-xl">×</button></div>
    <form onSubmit={(event) => { event.preventDefault(); onSearch(); }} className="mb-4 flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="商品名・型番・レアリティで検索" className="min-w-0 flex-1 rounded-xl border border-border-card bg-white px-4 py-2.5 outline-none focus:border-accent" /><button disabled={busy === 'catalog'} className="rounded-xl bg-text-primary px-5 text-sm font-bold text-white">{busy === 'catalog' ? '検索中' : '検索'}</button></form>
    {result && !result.snapshot.isCurrent && <p className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900">価格基準日: {result.snapshot.businessDate}（当日データではありません）</p>}
    <div className="grid max-h-[28rem] gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">{result?.cards.map((card) => { const existing = existingSourceIds.has(card.id); return <button type="button" key={card.id} disabled={existing} onClick={() => onToggle(card.id)} className={`flex gap-2 rounded-xl border bg-white p-2 text-left ${selection.has(card.id) ? 'border-accent ring-2 ring-accent/20' : 'border-border-card'} disabled:opacity-40`}><div className="relative h-20 w-14 shrink-0 overflow-hidden rounded-md bg-warm-100">{(card.image_url || card.alt_image_url) && <Image loader={passthroughImageLoader} unoptimized fill sizes="56px" src={(card.image_url || card.alt_image_url)!} alt={card.card_name} className="object-contain" />}</div><div className="min-w-0 flex-1"><p className="line-clamp-2 text-xs font-bold">{card.card_name}</p><p className="mt-1 truncate text-[10px] text-text-secondary">{[card.grade, card.list_no, card.rarity].filter(Boolean).join(' · ')}</p><p className="mt-2 text-xs font-bold text-accent">¥{card.price_high?.toLocaleString()}{productType === 'psa' && ` / ¥${card.price_low?.toLocaleString()}`}</p><span className="text-[9px] text-text-secondary">{existing ? '追加済み' : selection.has(card.id) ? '選択中' : 'クリックで選択'}</span></div></button>; })}</div>
    {result && result.cards.length === 0 && <p className="py-8 text-center text-sm text-text-secondary">該当商品がありません</p>}
    <div className="mt-4 flex items-center justify-between"><span className="text-sm font-bold">{selection.size}件選択</span><button type="button" onClick={onAdd} disabled={selection.size === 0 || busy === 'add'} className="rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy === 'add' ? '追加中...' : '選択したカードを追加'}</button></div>
  </section>;
}

function BulkToolbar({ locked, selected, total, operation, value, busy, undoCount, redoCount, setOperation, setValue, onSelectAll, onApply, onUndo, onRedo }: {
  locked: boolean; selected: number; total: number; operation: 'add' | 'percent' | 'round' | 'reset'; value: number; busy: boolean; undoCount: number; redoCount: number;
  setOperation: (value: 'add' | 'percent' | 'round' | 'reset') => void; setValue: (value: number) => void; onSelectAll: () => void; onApply: () => void; onUndo: () => void; onRedo: () => void;
}) {
  return <div className="flex flex-col gap-3 rounded-xl border border-border-card bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex items-center gap-2"><button type="button" disabled={locked} onClick={onSelectAll} className="rounded-lg border border-border-card px-3 py-2 text-xs font-bold disabled:opacity-30">{selected === total ? '全選択解除' : '全選択'}</button><span className="text-xs text-text-secondary">{selected}/{total}件</span><button type="button" onClick={onUndo} disabled={locked || !undoCount} className="rounded-lg px-2 py-2 text-xs font-bold disabled:opacity-30">↶ Undo</button><button type="button" onClick={onRedo} disabled={locked || !redoCount} className="rounded-lg px-2 py-2 text-xs font-bold disabled:opacity-30">↷ Redo</button></div>
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

function statusLabel(status: CustomBuybackSheetRow['status']): string {
  return ({ draft: '編集中', rendering: '画像生成中', ready: '生成済み', failed: '要確認' } as const)[status];
}

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
