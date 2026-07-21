export type ReviewMatchStatus = 'ambiguous' | 'unmatched' | 'invalid' | 'excluded';
export type ResolvableMatchStatus = Exclude<ReviewMatchStatus, 'invalid'>;

type DraftMappingBase = {
  itemId: string;
  cardLabel: string;
  matchStatus: ResolvableMatchStatus;
};

export type DraftMapping = DraftMappingBase & (
  | { kind: 'existing'; dbCardId: string }
  | { kind: 'new'; newCard: OrderListNewCardSelection }
  | { kind: 'exclude' }
);

export type DraftMappingsByImport = Record<string, Record<string, DraftMapping>>;

export type ReviewSummaryCounts = {
  matched: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
  excluded?: number;
};

export type ReviewSelectionProgress = {
  staged: number;
  excluded: number;
  handled: number;
  reflectable: number;
  unselected: number;
  invalid: number;
  ambiguousSelected: number;
  ambiguousUnselected: number;
  unmatchedSelected: number;
  unmatchedUnselected: number;
  excludedSelected: number;
};

export type ReviewStatusProgress = {
  total: number;
  selected: number;
  remaining: number;
};

export type OrderListMappingSelection = {
  item_id: string;
  db_card_id: string;
};

export type OrderListNewCardSelection = {
  item_id: string;
  card_name: string;
  grade: string;
  list_no: string;
  tag: string;
  alt_image_url: string | null;
};

export type OrderListExclusionSelection = {
  item_id: string;
};

export function isLaunchPendingConfirmation(result: {
  sync_started: boolean;
  launch_pending?: boolean;
}): boolean {
  return result.sync_started === false && result.launch_pending === true;
}

export function draftsForImport(
  draftsByImport: DraftMappingsByImport,
  importId: string,
): Record<string, DraftMapping> {
  return draftsByImport[importId] ?? {};
}

export function stageDraftMapping(
  draftsByImport: DraftMappingsByImport,
  importId: string,
  draft: DraftMapping,
): DraftMappingsByImport {
  return {
    ...draftsByImport,
    [importId]: {
      ...draftsForImport(draftsByImport, importId),
      [draft.itemId]: draft,
    },
  };
}

export function unstageDraftMapping(
  draftsByImport: DraftMappingsByImport,
  importId: string,
  itemId: string,
): DraftMappingsByImport {
  const current = draftsForImport(draftsByImport, importId);
  if (!current[itemId]) return draftsByImport;

  const nextForImport = { ...current };
  delete nextForImport[itemId];
  const next = { ...draftsByImport };
  if (Object.keys(nextForImport).length > 0) next[importId] = nextForImport;
  else delete next[importId];
  return next;
}

export function clearDraftMappings(
  draftsByImport: DraftMappingsByImport,
  importId: string,
): DraftMappingsByImport {
  if (!draftsByImport[importId]) return draftsByImport;
  const next = { ...draftsByImport };
  delete next[importId];
  return next;
}

export function mappingSelections(
  drafts: Record<string, DraftMapping>,
): OrderListMappingSelection[] {
  return Object.values(drafts)
    .filter((draft): draft is Extract<DraftMapping, { kind: 'existing' }> => draft.kind === 'existing')
    .sort((left, right) => left.itemId.localeCompare(right.itemId))
    .map((draft) => ({ item_id: draft.itemId, db_card_id: draft.dbCardId }));
}

export function newCardSelections(
  drafts: Record<string, DraftMapping>,
): OrderListNewCardSelection[] {
  return Object.values(drafts)
    .filter((draft): draft is Extract<DraftMapping, { kind: 'new' }> => draft.kind === 'new')
    .sort((left, right) => left.itemId.localeCompare(right.itemId))
    .map((draft) => draft.newCard);
}

export function exclusionSelections(
  drafts: Record<string, DraftMapping>,
): OrderListExclusionSelection[] {
  return Object.values(drafts)
    .filter((draft): draft is Extract<DraftMapping, { kind: 'exclude' }> => draft.kind === 'exclude')
    .sort((left, right) => left.itemId.localeCompare(right.itemId))
    .map((draft) => ({ item_id: draft.itemId }));
}

export function selectionProgress(
  summary: ReviewSummaryCounts,
  drafts: Record<string, DraftMapping>,
): ReviewSelectionProgress {
  const values = Object.values(drafts);
  const statusCounts = (status: ResolvableMatchStatus, total: number) => {
    const selected = values.filter((draft) => draft.matchStatus === status);
    const handled = Math.min(total, selected.length);
    const excluded = Math.min(handled, selected.filter((draft) => draft.kind === 'exclude').length);
    return { handled, excluded, reflectable: handled - excluded };
  };
  const ambiguous = statusCounts('ambiguous', summary.ambiguous);
  const unmatched = statusCounts('unmatched', summary.unmatched);
  const previouslyExcluded = statusCounts('excluded', summary.excluded ?? 0);
  const ambiguousSelected = ambiguous.handled;
  const unmatchedSelected = unmatched.handled;
  const ambiguousUnselected = Math.max(0, summary.ambiguous - ambiguousSelected);
  const unmatchedUnselected = Math.max(0, summary.unmatched - unmatchedSelected);
  const staged = ambiguous.reflectable + unmatched.reflectable + previouslyExcluded.reflectable;
  const excluded = ambiguous.excluded + unmatched.excluded;
  return {
    staged,
    excluded,
    handled: staged + excluded,
    reflectable: summary.matched + staged,
    unselected: ambiguousUnselected + unmatchedUnselected,
    invalid: summary.invalid,
    ambiguousSelected,
    ambiguousUnselected,
    unmatchedSelected,
    unmatchedUnselected,
    excludedSelected: previouslyExcluded.reflectable,
  };
}

const REVIEW_STATUS_ORDER: ReviewMatchStatus[] = ['ambiguous', 'unmatched', 'invalid', 'excluded'];

export function firstReviewStatus(summary: ReviewSummaryCounts): ReviewMatchStatus | null {
  return REVIEW_STATUS_ORDER.find((status) => (summary[status] ?? 0) > 0) ?? null;
}

export function nextReviewStatus(
  current: ReviewMatchStatus,
  summary: ReviewSummaryCounts,
): ReviewMatchStatus | null {
  const currentIndex = REVIEW_STATUS_ORDER.indexOf(current);
  return REVIEW_STATUS_ORDER
    .slice(currentIndex + 1)
    .find((status) => (summary[status] ?? 0) > 0) ?? null;
}

export function reviewStatusProgress(
  summary: ReviewSummaryCounts,
  drafts: Record<string, DraftMapping>,
  status: ReviewMatchStatus,
): ReviewStatusProgress {
  const progress = selectionProgress(summary, drafts);
  if (status === 'ambiguous') {
    return {
      total: summary.ambiguous,
      selected: progress.ambiguousSelected,
      remaining: progress.ambiguousUnselected,
    };
  }
  if (status === 'unmatched') {
    return {
      total: summary.unmatched,
      selected: progress.unmatchedSelected,
      remaining: progress.unmatchedUnselected,
    };
  }
  if (status === 'excluded') {
    return {
      total: summary.excluded ?? 0,
      selected: progress.excludedSelected,
      remaining: 0,
    };
  }
  return { total: summary.invalid, selected: 0, remaining: summary.invalid };
}

export function canConfirmOrderListImport(params: {
  status: string;
  structuralValid: boolean | undefined;
  persistenceComplete: boolean | undefined;
  matchedCount: number;
  stagedCount?: number;
}): boolean {
  const retryingConfirmedLaunch = params.status === 'confirmed';
  const confirmingSelections = params.status === 'parsed' || params.status === 'failed';
  return (retryingConfirmedLaunch || confirmingSelections)
    && params.structuralValid !== false
    && params.persistenceComplete === true
    && params.matchedCount + (params.stagedCount ?? 0) > 0;
}

export function canSyncOrderListImport(params: {
  status: string;
  structuralValid: boolean | undefined;
  persistenceComplete: boolean | undefined;
  matchedCount: number;
  stagedCount?: number;
}): boolean {
  return ['parsed', 'failed', 'confirmed', 'applied'].includes(params.status)
    && params.structuralValid !== false
    && params.persistenceComplete === true
    && params.matchedCount + (params.stagedCount ?? 0) > 0;
}

export function shouldResyncOrderListImport(params: {
  status: string;
  appliedSummary?: unknown;
}): boolean {
  return params.status === 'applied'
    || (['confirmed', 'failed'].includes(params.status) && params.appliedSummary != null);
}

export type OrderListImportSelectionCandidate = {
  id: string;
  status: string;
  structural_valid?: boolean;
  persistence_complete?: boolean;
};

/**
 * APIの新しい順を維持し、初回表示では最初の正常保存済み取込を選ぶ。
 * 操作者が明示的に選んだ履歴は、一覧に残っている限り更新後も保持する。
 */
export function latestUsableOrderListImportId(
  imports: readonly OrderListImportSelectionCandidate[],
): string {
  return imports.find((item) => item.structural_valid === true
    && item.persistence_complete === true)?.id ?? imports[0]?.id ?? '';
}

export function selectDefaultOrderListImportId(
  imports: readonly OrderListImportSelectionCandidate[],
  currentId = '',
): string {
  if (currentId && imports.some((item) => item.id === currentId)) return currentId;
  return latestUsableOrderListImportId(imports);
}

export function isLatestOrderListImportId(
  imports: readonly OrderListImportSelectionCandidate[],
  selectedId: string,
): boolean {
  return selectedId !== '' && latestUsableOrderListImportId(imports) === selectedId;
}

type OrderListSyncRequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function syncRequestStorageKey(importId: string): string {
  return 'haraka:order-list-sync-request:' + importId;
}

export function getOrCreateOrderListSyncRequestId(
  storage: OrderListSyncRequestStorage,
  importId: string,
  payloadSignature: string,
  createId: () => string,
): string {
  const key = syncRequestStorageKey(importId);
  const stored = storage.getItem(key)?.trim();
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { requestId?: unknown; payloadSignature?: unknown };
      if (typeof parsed.requestId === 'string'
        && parsed.requestId.trim()
        && parsed.payloadSignature === payloadSignature) {
        return parsed.requestId;
      }
    } catch {
      // Old or corrupted values are replaced with a fingerprint-bound request ID.
    }
  }
  const created = createId().trim();
  if (!created) throw new Error('同期操作IDを生成できませんでした');
  storage.setItem(key, JSON.stringify({ requestId: created, payloadSignature }));
  return created;
}

export function clearOrderListSyncRequestId(
  storage: OrderListSyncRequestStorage,
  importId: string,
): void {
  storage.removeItem(syncRequestStorageKey(importId));
}

export function resetFileInputValue(input: { value: string } | null): void {
  if (input) input.value = '';
}

export function unselectedConfirmationMessage(
  progress: ReviewSelectionProgress,
  action: 'reflect' | 'sync' | 'save' = 'sync',
): string | null {
  if (progress.unselected === 0 && progress.invalid === 0) return null;

  const warnings: string[] = [];
  if (progress.unselected > 0) {
    const breakdown = [
      progress.ambiguousUnselected > 0 ? `曖昧${progress.ambiguousUnselected.toLocaleString()}件` : null,
      progress.unmatchedUnselected > 0 ? `未照合${progress.unmatchedUnselected.toLocaleString()}件` : null,
    ].filter(Boolean).join('・');
    warnings.push(`未選択の商品が${progress.unselected.toLocaleString()}件あります${breakdown ? `（${breakdown}）` : ''}。`);
  }
  if (progress.invalid > 0) {
    warnings.push(action === 'save'
      ? `入力エラーの行が${progress.invalid.toLocaleString()}件あり、対応表へ保存されません。`
      : `入力エラーの行が${progress.invalid.toLocaleString()}件あり、同期されません。`);
  }
  warnings.push(action === 'save'
    ? `今回指定した${progress.handled.toLocaleString()}件（対応${progress.staged.toLocaleString()}件・除外${progress.excluded.toLocaleString()}件）だけを保存します。よろしいですか？`
    : `未選択の商品を含めず、照合済み${progress.reflectable.toLocaleString()}件を同期します。よろしいですか？`);
  return warnings.join('\n');
}
