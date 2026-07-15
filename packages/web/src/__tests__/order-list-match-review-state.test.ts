import {
  draftsForImport,
  firstReviewStatus,
  mappingSelections,
  nextReviewStatus,
  resetFileInputValue,
  reviewStatusProgress,
  selectionProgress,
  stageDraftMapping,
  unselectedConfirmationMessage,
  unstageDraftMapping,
  type DraftMappingsByImport,
} from '../app/runs/order-list-match-review-state';

test('仮選択は取込ごとに保持し、同じ商品を選び直すと上書きする', () => {
  let state: DraftMappingsByImport = {};
  state = stageDraftMapping(state, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  });
  state = stageDraftMapping(state, 'import-2', {
    itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  });
  state = stageDraftMapping(state, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3', matchStatus: 'ambiguous',
  });

  expect(draftsForImport(state, 'import-1')).toEqual({
    'item-1': { itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3', matchStatus: 'ambiguous' },
  });
  expect(draftsForImport(state, 'import-2')).toEqual({
    'item-2': { itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched' },
  });
});

test('仮選択の解除は別の取込に影響しない', () => {
  const initial = stageDraftMapping(stageDraftMapping({}, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-2', {
    itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  });

  const next = unstageDraftMapping(initial, 'import-1', 'item-1');
  expect(draftsForImport(next, 'import-1')).toEqual({});
  expect(Object.keys(draftsForImport(next, 'import-2'))).toEqual(['item-2']);
});

test('未選択数は曖昧・未照合から仮選択を引き、入力エラーは別計上する', () => {
  const drafts = draftsForImport(stageDraftMapping({}, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-1');
  const progress = selectionProgress({
    matched: 821, ambiguous: 74, unmatched: 77, invalid: 2,
  }, drafts);

  expect(progress).toEqual({
    staged: 1,
    reflectable: 822,
    unselected: 150,
    invalid: 2,
    ambiguousSelected: 1,
    ambiguousUnselected: 73,
    unmatchedSelected: 0,
    unmatchedUnselected: 77,
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
    itemId: 'item-b', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
  }), 'import-1', {
    itemId: 'item-a', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  }), 'import-1');

  expect(mappingSelections(drafts)).toEqual([
    { item_id: 'item-a', db_card_id: 'card-1' },
    { item_id: 'item-b', db_card_id: 'card-2' },
  ]);
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
    itemId: 'ambiguous-1', dbCardId: 'card-1', cardLabel: '候補1', matchStatus: 'ambiguous',
  });
  state = stageDraftMapping(state, 'import-1', {
    itemId: 'unmatched-1', dbCardId: 'card-2', cardLabel: '候補2', matchStatus: 'unmatched',
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
      itemId: `ambiguous-${index}`,
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
    '選択済みを含む895件だけを反映します。よろしいですか？',
  ].join('\n'));
  expect(unselectedConfirmationMessage(progress, 'save')).toBe([
    '未選択の商品が77件あります（未照合77件）。',
    '今回選択した74件だけを対応表へ保存します。よろしいですか？',
  ].join('\n'));
});

test('曖昧74件と未照合77件を全選択すると972件が反映対象になり警告が消える', () => {
  let state: DraftMappingsByImport = {};
  for (let index = 0; index < 74; index += 1) {
    state = stageDraftMapping(state, 'import-1', {
      itemId: `ambiguous-${index}`,
      dbCardId: `ambiguous-card-${index}`,
      cardLabel: `曖昧候補${index}`,
      matchStatus: 'ambiguous',
    });
  }
  for (let index = 0; index < 77; index += 1) {
    state = stageDraftMapping(state, 'import-1', {
      itemId: `unmatched-${index}`,
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
    itemId: 'stale-item', dbCardId: 'card-1', cardLabel: '古い候補', matchStatus: 'ambiguous',
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
