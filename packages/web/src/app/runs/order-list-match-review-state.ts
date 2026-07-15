export type ReviewMatchStatus = 'ambiguous' | 'unmatched' | 'invalid';
export type ResolvableMatchStatus = Exclude<ReviewMatchStatus, 'invalid'>;

export type DraftMapping = {
  itemId: string;
  dbCardId: string;
  cardLabel: string;
  matchStatus: ResolvableMatchStatus;
};

export type DraftMappingsByImport = Record<string, Record<string, DraftMapping>>;

export type ReviewSummaryCounts = {
  matched: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
};

export type ReviewSelectionProgress = {
  staged: number;
  reflectable: number;
  unselected: number;
  invalid: number;
  ambiguousSelected: number;
  ambiguousUnselected: number;
  unmatchedSelected: number;
  unmatchedUnselected: number;
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
    .sort((left, right) => left.itemId.localeCompare(right.itemId))
    .map((draft) => ({ item_id: draft.itemId, db_card_id: draft.dbCardId }));
}

export function selectionProgress(
  summary: ReviewSummaryCounts,
  drafts: Record<string, DraftMapping>,
): ReviewSelectionProgress {
  const values = Object.values(drafts);
  const ambiguousSelected = Math.min(summary.ambiguous, values.filter((draft) => draft.matchStatus === 'ambiguous').length);
  const unmatchedSelected = Math.min(summary.unmatched, values.filter((draft) => draft.matchStatus === 'unmatched').length);
  const ambiguousUnselected = Math.max(0, summary.ambiguous - ambiguousSelected);
  const unmatchedUnselected = Math.max(0, summary.unmatched - unmatchedSelected);
  const staged = ambiguousSelected + unmatchedSelected;
  return {
    staged,
    reflectable: summary.matched + staged,
    unselected: ambiguousUnselected + unmatchedUnselected,
    invalid: summary.invalid,
    ambiguousSelected,
    ambiguousUnselected,
    unmatchedSelected,
    unmatchedUnselected,
  };
}

const REVIEW_STATUS_ORDER: ReviewMatchStatus[] = ['ambiguous', 'unmatched', 'invalid'];

export function firstReviewStatus(summary: ReviewSummaryCounts): ReviewMatchStatus | null {
  return REVIEW_STATUS_ORDER.find((status) => summary[status] > 0) ?? null;
}

export function nextReviewStatus(
  current: ReviewMatchStatus,
  summary: ReviewSummaryCounts,
): ReviewMatchStatus | null {
  const currentIndex = REVIEW_STATUS_ORDER.indexOf(current);
  return REVIEW_STATUS_ORDER
    .slice(currentIndex + 1)
    .find((status) => summary[status] > 0) ?? null;
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
  return { total: summary.invalid, selected: 0, remaining: summary.invalid };
}

export function resetFileInputValue(input: { value: string } | null): void {
  if (input) input.value = '';
}

export function unselectedConfirmationMessage(
  progress: ReviewSelectionProgress,
  action: 'reflect' | 'save' = 'reflect',
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
      : `入力エラーの行が${progress.invalid.toLocaleString()}件あり、反映されません。`);
  }
  warnings.push(action === 'save'
    ? `今回選択した${progress.staged.toLocaleString()}件だけを対応表へ保存します。よろしいですか？`
    : `選択済みを含む${progress.reflectable.toLocaleString()}件だけを反映します。よろしいですか？`);
  return warnings.join('\n');
}