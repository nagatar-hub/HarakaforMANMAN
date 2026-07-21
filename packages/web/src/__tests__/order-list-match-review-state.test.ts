import {
  canConfirmOrderListImport,
  canSyncOrderListImport,
  clearOrderListSyncRequestId,
  exclusionSelections,
  draftsForImport,
  firstReviewStatus,
  getOrCreateOrderListSyncRequestId,
  isLatestOrderListImportId,
  latestUsableOrderListImportId,
  isLaunchPendingConfirmation,
  mappingSelections,
  newCardSelections,
  nextReviewStatus,
  resetFileInputValue,
  reviewStatusProgress,
  selectDefaultOrderListImportId,
  selectionProgress,
  shouldResyncOrderListImport,
  stageDraftMapping,
  unselectedConfirmationMessage,
  unstageDraftMapping,
  type DraftMappingsByImport,
} from '../app/runs/order-list-match-review-state';

test('履歴の初期選択は未解決件数ではなく最初の正常保存済み取込を選ぶ', () => {
  const imports = [
    { id: 'latest-parsed', status: 'parsed' },
    { id: 'older-applied-with-unresolved', status: 'applied' },
  ];

  expect(selectDefaultOrderListImportId(imports)).toBe('latest-parsed');
});

test('一覧先頭が反映済みでも状態に関係なく先頭を選ぶ', () => {
  expect(selectDefaultOrderListImportId([
    { id: 'latest-applied', status: 'applied' },
    { id: 'processing', status: 'processing' },
    { id: 'older-parsed', status: 'parsed' },
  ])).toBe('latest-applied');

  expect(selectDefaultOrderListImportId([
    { id: 'historical-failed-resync', status: 'failed' },
    { id: 'new-parsed', status: 'parsed' },
  ])).toBe('historical-failed-resync');


  expect(selectDefaultOrderListImportId([
    { id: 'latest-applied', status: 'applied' },
    { id: 'older-applied', status: 'applied' },
  ])).toBe('latest-applied');
});

test('操作者が選んだ履歴は更新後も存在する限り保持する', () => {
  const imports = [
    { id: 'latest-parsed', status: 'parsed' },
    { id: 'selected-applied', status: 'applied' },
  ];

  expect(selectDefaultOrderListImportId(imports, 'selected-applied')).toBe('selected-applied');
  expect(selectDefaultOrderListImportId(imports, 'removed-import')).toBe('latest-parsed');
  expect(selectDefaultOrderListImportId([], 'removed-import')).toBe('');
});

test('同期可能な最新取込は共通helperのIDだけで判定する', () => {
  const imports = [
    { id: 'latest-applied', status: 'applied' },
    { id: 'historical-parsed', status: 'parsed' },
  ];

  expect(isLatestOrderListImportId(imports, 'latest-applied')).toBe(true);
  expect(isLatestOrderListImportId(imports, 'historical-parsed')).toBe(false);
  expect(isLatestOrderListImportId([], 'latest-applied')).toBe(false);
  expect(isLatestOrderListImportId(imports, '')).toBe(false);
});

test('先頭が構造不正または保存未完了なら次の正常保存済み取込を選ぶ', () => {
  const imports = [
    { id: 'latest-invalid', status: 'failed', structural_valid: false, persistence_complete: true },
    { id: 'latest-incomplete', status: 'failed', structural_valid: true, persistence_complete: false },
    { id: 'latest-usable', status: 'applied', structural_valid: true, persistence_complete: true },
    { id: 'older-usable', status: 'applied', structural_valid: true, persistence_complete: true },
  ];

  expect(latestUsableOrderListImportId(imports)).toBe('latest-usable');
  expect(selectDefaultOrderListImportId(imports)).toBe('latest-usable');
  expect(isLatestOrderListImportId(imports, 'latest-usable')).toBe(true);
  expect(isLatestOrderListImportId(imports, 'latest-invalid')).toBe(false);
  expect(latestUsableOrderListImportId(imports.slice(0, 2))).toBe('latest-invalid');
});

test('仮選択は取込ごとに保持し、同じ商品を選び直すと上書きする', () => {
  let state: DraftMappingsByImport = {};
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  });
  state = stageDraftMapping(state, 'import-2', {
    kind: 'existing', itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  });
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3', matchStatus: 'ambiguous',
  });

  expect(draftsForImport(state, 'import-1')).toEqual({
    'item-1': { kind: 'existing', itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3', matchStatus: 'ambiguous' },
  });
  expect(draftsForImport(state, 'import-2')).toEqual({
    'item-2': { kind: 'existing', itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched' },
  });
});

test('launch pending confirmation keeps the review and retry path visible', () => {
  expect(isLaunchPendingConfirmation({
    sync_started: false,
    launch_pending: true,
  })).toBe(true);
  expect(isLaunchPendingConfirmation({
    sync_started: true,
    launch_pending: true,
  })).toBe(false);
  expect(isLaunchPendingConfirmation({
    sync_started: false,
    launch_pending: false,
  })).toBe(false);
});

test('仮選択の解除は別の取込に影響しない', () => {
  const initial = stageDraftMapping(stageDraftMapping({}, 'import-1', {
    kind: 'existing', itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-2', {
    kind: 'existing', itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  });

  const next = unstageDraftMapping(initial, 'import-1', 'item-1');
  expect(draftsForImport(next, 'import-1')).toEqual({});
  expect(Object.keys(draftsForImport(next, 'import-2'))).toEqual(['item-2']);
});

test('未選択数は曖昧・未照合から仮選択を引き、入力エラーは別計上する', () => {
  const drafts = draftsForImport(stageDraftMapping({}, 'import-1', {
    kind: 'existing', itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-1');
  const progress = selectionProgress({
    matched: 821, ambiguous: 74, unmatched: 77, invalid: 2,
  }, drafts);

  expect(progress).toEqual({
    staged: 1,
    excluded: 0,
    handled: 1,
    reflectable: 822,
    unselected: 150,
    invalid: 2,
    ambiguousSelected: 1,
    ambiguousUnselected: 73,
    unmatchedSelected: 0,
    unmatchedUnselected: 77,
    excludedSelected: 0,
  });
  expect(unselectedConfirmationMessage(progress)).toContain('未選択の商品が150件あります');
  expect(unselectedConfirmationMessage(progress)).toContain('曖昧73件・未照合77件');
  expect(unselectedConfirmationMessage(progress)).toContain('入力エラーの行が2件');
});

test('未選択も入力エラーもなければ最終警告を出さない', () => {
  const progress = selectionProgress({
    matched: 1, ambiguous: 0, unmatched: 0, invalid: 0,
  }, {});
  expect(unselectedConfirmationMessage(progress)).toBeNull();
});

test('最終POST用の対応付けはitem_id順で一意に生成する', () => {
  const drafts = draftsForImport(stageDraftMapping(stageDraftMapping({}, 'import-1', {
    kind: 'existing', itemId: 'item-b', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  }), 'import-1', {
    kind: 'existing', itemId: 'item-a', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-1');

  expect(mappingSelections(drafts)).toEqual([
    { item_id: 'item-a', db_card_id: 'card-1' },
    { item_id: 'item-b', db_card_id: 'card-2' },
  ]);
});

test('既存DB対応と新規DB商品を別payloadに分け、進捗では両方を選択済みにする', () => {
  let state: DraftMappingsByImport = {};
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'item-b', dbCardId: 'card-2', cardLabel: '既存候補', matchStatus: 'unmatched',
  });
  state = stageDraftMapping(state, 'import-1', {
    kind: 'new', itemId: 'item-a', cardLabel: '新商品 / PSA10 / 001 / TOP', matchStatus: 'unmatched',
    newCard: {
      item_id: 'item-a', card_name: '新商品', grade: 'PSA10', list_no: '001', tag: 'TOP', alt_image_url: null,
    },
  });
  const drafts = draftsForImport(state, 'import-1');

  expect(mappingSelections(drafts)).toEqual([{ item_id: 'item-b', db_card_id: 'card-2' }]);
  expect(newCardSelections(drafts)).toEqual([{
    item_id: 'item-a', card_name: '新商品', grade: 'PSA10', list_no: '001', tag: 'TOP', alt_image_url: null,
  }]);
  expect(selectionProgress({ matched: 10, ambiguous: 0, unmatched: 2, invalid: 0 }, drafts))
    .toMatchObject({ staged: 2, reflectable: 12, unselected: 0 });
});

test('同じExcel商品を新規登録から既存DB対応へ変更するとpayloadも置き換わる', () => {
  let state: DraftMappingsByImport = stageDraftMapping({}, 'import-1', {
    kind: 'new', itemId: 'item-1', cardLabel: '新商品', matchStatus: 'ambiguous',
    newCard: {
      item_id: 'item-1', card_name: '新商品', grade: '', list_no: '', tag: '通常', alt_image_url: null,
    },
  });
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'item-1', dbCardId: 'card-1', cardLabel: '既存商品', matchStatus: 'ambiguous',
  });
  const drafts = draftsForImport(state, 'import-1');

  expect(newCardSelections(drafts)).toEqual([]);
  expect(mappingSelections(drafts)).toEqual([{ item_id: 'item-1', db_card_id: 'card-1' }]);
});
test('件数がある最初の確認区分を選び、空の区分を飛ばして次へ進む', () => {
  const appliedSummary = { matched: 895, ambiguous: 0, unmatched: 77, invalid: 0 };
  expect(firstReviewStatus(appliedSummary)).toBe('unmatched');
  expect(nextReviewStatus('ambiguous', appliedSummary)).toBe('unmatched');
  expect(nextReviewStatus('unmatched', appliedSummary)).toBeNull();

  const invalidSummary = { matched: 1, ambiguous: 1, unmatched: 0, invalid: 2 };
  expect(nextReviewStatus('ambiguous', invalidSummary)).toBe('invalid');

  const allSteps = { matched: 1, ambiguous: 1, unmatched: 1, invalid: 1 };
  expect(nextReviewStatus('ambiguous', allSteps)).toBe('unmatched');
  expect(nextReviewStatus('unmatched', allSteps)).toBe('invalid');
  expect(nextReviewStatus('invalid', allSteps)).toBeNull();

  const resolvedSummary = { matched: 972, ambiguous: 0, unmatched: 0, invalid: 0 };
  expect(firstReviewStatus(resolvedSummary)).toBeNull();
});

test('区分別の選択進捗を分離して計算する', () => {
  let state: DraftMappingsByImport = {};
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'ambiguous-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  });
  state = stageDraftMapping(state, 'import-1', {
    kind: 'existing', itemId: 'unmatched-1', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  });
  const drafts = draftsForImport(state, 'import-1');
  const summary = { matched: 10, ambiguous: 2, unmatched: 3, invalid: 1 };

  expect(reviewStatusProgress(summary, drafts, 'ambiguous')).toEqual({
    total: 2, selected: 1, remaining: 1,
  });
  expect(reviewStatusProgress(summary, drafts, 'unmatched')).toEqual({
    total: 3, selected: 1, remaining: 2,
  });
  expect(reviewStatusProgress(summary, drafts, 'invalid')).toEqual({
    total: 1, selected: 0, remaining: 1,
  });
});

test('今回の74件を選んだ時点では未照合77件が明示的に残る', () => {
  let state: DraftMappingsByImport = {};
  for (let index = 0; index < 74; index += 1) {
    state = stageDraftMapping(state, 'import-1', {
      kind: 'existing', itemId: `ambiguous-${index}`,
      dbCardId: `card-${index}`,
      cardLabel: `候補${index}`,
      matchStatus: 'ambiguous',
    });
  }
  const progress = selectionProgress(
    { matched: 821, ambiguous: 74, unmatched: 77, invalid: 0 },
    draftsForImport(state, 'import-1'),
  );

  expect(progress).toMatchObject({ staged: 74, reflectable: 895, unselected: 77 });
  expect(unselectedConfirmationMessage(progress)).toBe([
    '未選択の商品が77件あります（未照合77件）。',
    '未選択の商品を含めず、照合済み895件を同期します。よろしいですか？',
  ].join('\n'));
  expect(unselectedConfirmationMessage(progress, 'save')).toBe([
    '未選択の商品が77件あります（未照合77件）。',
    '今回指定した74件（対応74件・除外0件）だけを保存します。よろしいですか？',
  ].join('\n'));
});

test('曖昧74件と未照合77件を全選択すると972件が反映対象になり警告が消える', () => {
  let state: DraftMappingsByImport = {};
  for (let index = 0; index < 74; index += 1) {
    state = stageDraftMapping(state, 'import-1', {
      kind: 'existing', itemId: `ambiguous-${index}`,
      dbCardId: `ambiguous-card-${index}`,
      cardLabel: `曖昧候補${index}`,
      matchStatus: 'ambiguous',
    });
  }
  for (let index = 0; index < 77; index += 1) {
    state = stageDraftMapping(state, 'import-1', {
      kind: 'existing', itemId: `unmatched-${index}`,
      dbCardId: `unmatched-card-${index}`,
      cardLabel: `未照合候補${index}`,
      matchStatus: 'unmatched',
    });
  }
  const progress = selectionProgress(
    { matched: 821, ambiguous: 74, unmatched: 77, invalid: 0 },
    draftsForImport(state, 'import-1'),
  );

  expect(progress).toMatchObject({ staged: 151, reflectable: 972, unselected: 0 });
  expect(unselectedConfirmationMessage(progress)).toBeNull();
});

test('照合件数を超える古い仮選択は進捗へ過大計上しない', () => {
  const staleDrafts = draftsForImport(stageDraftMapping({}, 'import-1', {
    kind: 'existing', itemId: 'stale-item', dbCardId: 'card-1', cardLabel: '古い候補', matchStatus: 'ambiguous',
  }), 'import-1');
  const progress = selectionProgress(
    { matched: 10, ambiguous: 0, unmatched: 0, invalid: 0 },
    staleDrafts,
  );
  expect(progress).toMatchObject({ staged: 0, reflectable: 10, unselected: 0 });
});

test('同じExcelを再選択できるようfile inputの値を消す', () => {
  const input = { value: 'C:\\fakepath\\order-list-20260714.xlsx' };
  resetFileInputValue(input);
  expect(input.value).toBe('');
});

test('confirmed import remains confirmable to retry a failed job launch', () => {
  expect(canConfirmOrderListImport({
    status: 'confirmed',
    structuralValid: true,
    persistenceComplete: true,
    matchedCount: 895,
  })).toBe(true);
  expect(canConfirmOrderListImport({
    status: 'processing',
    structuralValid: true,
    persistenceComplete: true,
    matchedCount: 895,
  })).toBe(false);
});
test('再同期の操作IDは通信失敗時に再利用し、成功後に破棄できる', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let generated = 0;
  const createId = () => 'request-' + (++generated);

  expect(getOrCreateOrderListSyncRequestId(storage, 'import-1', 'payload-a', createId)).toBe('request-1');
  expect(getOrCreateOrderListSyncRequestId(storage, 'import-1', 'payload-a', createId)).toBe('request-1');
  expect(getOrCreateOrderListSyncRequestId(storage, 'import-1', 'payload-b', createId)).toBe('request-2');
  clearOrderListSyncRequestId(storage, 'import-1');
  expect(getOrCreateOrderListSyncRequestId(storage, 'import-1', 'payload-b', createId)).toBe('request-3');
});

test('再同期済み履歴だけconfirmed・failedでもresync経路を使う', () => {
  expect(shouldResyncOrderListImport({ status: 'applied' })).toBe(true);
  expect(shouldResyncOrderListImport({ status: 'confirmed', appliedSummary: { matched: 10 } })).toBe(true);
  expect(shouldResyncOrderListImport({ status: 'failed', appliedSummary: { matched: 10 } })).toBe(true);
  expect(shouldResyncOrderListImport({ status: 'confirmed', appliedSummary: null })).toBe(false);
  expect(shouldResyncOrderListImport({ status: 'failed' })).toBe(false);
  expect(shouldResyncOrderListImport({ status: 'parsed' })).toBe(false);
});

test('applied importは選択0件でも既存の照合済み商品を同期できる', () => {
  expect(canSyncOrderListImport({
    status: 'applied',
    structuralValid: true,
    persistenceComplete: true,
    matchedCount: 893,
    stagedCount: 0,
  })).toBe(true);
  expect(canSyncOrderListImport({
    status: 'applied',
    structuralValid: true,
    persistenceComplete: true,
    matchedCount: 0,
    stagedCount: 0,
  })).toBe(false);
});

test('買取表に載せない選択は対応payloadと分離し未選択数だけを減らす', () => {
  const state = stageDraftMapping({}, 'import-1', {
    kind: 'exclude',
    itemId: 'item-1',
    cardLabel: '買取表に載せない',
    matchStatus: 'unmatched',
  });
  const drafts = draftsForImport(state, 'import-1');
  const progress = selectionProgress(
    { matched: 893, ambiguous: 0, unmatched: 78, invalid: 0 },
    drafts,
  );

  expect(exclusionSelections(drafts)).toEqual([{ item_id: 'item-1' }]);
  expect(mappingSelections(drafts)).toEqual([]);
  expect(newCardSelections(drafts)).toEqual([]);
  expect(progress).toMatchObject({
    staged: 0,
    excluded: 1,
    handled: 1,
    reflectable: 893,
    unselected: 77,
    unmatchedSelected: 1,
  });
  expect(unselectedConfirmationMessage(progress)).toBe([
    '未選択の商品が77件あります（未照合77件）。',
    '未選択の商品を含めず、照合済み893件を同期します。よろしいですか？',
  ].join('\n'));
});

test('過去に除外した商品をDB商品へ対応付けると除外解除分として同期対象へ戻す', () => {
  const state = stageDraftMapping({}, 'import-1', {
    kind: 'existing',
    itemId: 'item-1',
    dbCardId: 'card-1',
    cardLabel: '既存商品',
    matchStatus: 'excluded',
  });
  const drafts = draftsForImport(state, 'import-1');
  const summary = { matched: 893, ambiguous: 0, unmatched: 0, invalid: 0, excluded: 1 };
  const progress = selectionProgress(summary, drafts);

  expect(mappingSelections(drafts)).toEqual([{ item_id: 'item-1', db_card_id: 'card-1' }]);
  expect(exclusionSelections(drafts)).toEqual([]);
  expect(progress).toMatchObject({
    staged: 1,
    excluded: 0,
    handled: 1,
    reflectable: 894,
    unselected: 0,
    excludedSelected: 1,
  });
  expect(reviewStatusProgress(summary, drafts, 'excluded')).toEqual({
    total: 1,
    selected: 1,
    remaining: 0,
  });
});
