import {
  draftsForImport,
  mappingSelections,
  selectionProgress,
  stageDraftMapping,
  unselectedConfirmationMessage,
  unstageDraftMapping,
  type DraftMappingsByImport,
} from '../app/runs/order-list-match-review-state';

test('仮選択は取込ごとに保持し、同じ商品を選び直すと上書きする', () => {
  let state: DraftMappingsByImport = {};
  state = stageDraftMapping(state, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1',
  });
  state = stageDraftMapping(state, 'import-2', {
    itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2',
  });
  state = stageDraftMapping(state, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3',
  });

  expect(draftsForImport(state, 'import-1')).toEqual({
    'item-1': { itemId: 'item-1', dbCardId: 'card-3', cardLabel: '候補3' },
  });
  expect(draftsForImport(state, 'import-2')).toEqual({
    'item-2': { itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2' },
  });
});

test('仮選択の解除は別の取込に影響しない', () => {
  const initial = stageDraftMapping(stageDraftMapping({}, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1',
  }), 'import-2', {
    itemId: 'item-2', dbCardId: 'card-2', cardLabel: '候補2',
  });

  const next = unstageDraftMapping(initial, 'import-1', 'item-1');
  expect(draftsForImport(next, 'import-1')).toEqual({});
  expect(Object.keys(draftsForImport(next, 'import-2'))).toEqual(['item-2']);
});

test('未選択数は曖昧・未照合から仮選択を引き、入力エラーは別計上する', () => {
  const drafts = draftsForImport(stageDraftMapping({}, 'import-1', {
    itemId: 'item-1', dbCardId: 'card-1', cardLabel: '候補1',
  }), 'import-1');
  const progress = selectionProgress({
    matched: 821, ambiguous: 74, unmatched: 77, invalid: 2,
  }, drafts);

  expect(progress).toEqual({ staged: 1, reflectable: 822, unselected: 150, invalid: 2 });
  expect(unselectedConfirmationMessage(progress)).toContain('未選択の商品が150件あります');
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
    itemId: 'item-b', dbCardId: 'card-2', cardLabel: '候補2',
  }), 'import-1', {
    itemId: 'item-a', dbCardId: 'card-1', cardLabel: '候補1',
  }), 'import-1');

  expect(mappingSelections(drafts)).toEqual([
    { item_id: 'item-a', db_card_id: 'card-1' },
    { item_id: 'item-b', db_card_id: 'card-2' },
  ]);
});