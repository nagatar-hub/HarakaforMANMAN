export type DraftMapping = {
  itemId: string;
  dbCardId: string;
  cardLabel: string;
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
  const staged = Object.keys(drafts).length;
  return {
    staged,
    reflectable: summary.matched + staged,
    unselected: Math.max(0, summary.ambiguous + summary.unmatched - staged),
    invalid: summary.invalid,
  };
}

export function unselectedConfirmationMessage(
  progress: ReviewSelectionProgress,
): string | null {
  if (progress.unselected === 0 && progress.invalid === 0) return null;

  const warnings: string[] = [];
  if (progress.unselected > 0) {
    warnings.push(`未選択の商品が${progress.unselected.toLocaleString()}件あります。`);
  }
  if (progress.invalid > 0) {
    warnings.push(`入力エラーの行が${progress.invalid.toLocaleString()}件あり、反映されません。`);
  }
  warnings.push(`選択済みを含む${progress.reflectable.toLocaleString()}件だけを反映します。よろしいですか？`);
  return warnings.join('\n');
}