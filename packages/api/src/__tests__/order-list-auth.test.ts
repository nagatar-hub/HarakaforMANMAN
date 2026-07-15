import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  orderListImportRoutes,
  canEditOrderListMappings,
  orderListSyncRequestFingerprint,
  isDefinitiveCloudRunJobRejection,
  parseOrderListConfirmPayload,
  parseOrderListExclusionSelections,
  parseOrderListMappingSelections,
  parseOrderListNewCardSelections,
  parseOrderListResyncPayload,
  parseOrderListSelectionsPayload,
} from '../routes/order-list-imports.js';

const originalToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  else process.env.ORDER_LIST_IMPORT_API_TOKEN = originalToken;
});

test('オーダーリストAPIは認証設定がなければfail closedする', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await orderListImportRoutes.request('/order-list/imports');
  assert.equal(response.status, 503);
});

test('オーダーリストAPIは不正なBearer tokenを拒否する', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  const response = await orderListImportRoutes.request('/order-list/imports', {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(response.status, 401);
});

test('認証済みでも16MBを越えるupload bodyは解析前に拒否する', async () => {
  const token = 'a'.repeat(32);
  process.env.ORDER_LIST_IMPORT_API_TOKEN = token;
  const response = await orderListImportRoutes.request('/order-list/imports', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(16 * 1024 * 1024 + 1),
    },
    body: 'x',
  });
  assert.equal(response.status, 413);
});

test('staged mapping PATCH is available only after the import is applied', () => {
  assert.equal(canEditOrderListMappings('applied'), true);
  assert.equal(canEditOrderListMappings('parsed'), false);
  assert.equal(canEditOrderListMappings('failed'), false);
  assert.equal(canEditOrderListMappings('confirmed'), false);
  assert.equal(canEditOrderListMappings('processing'), false);
});



test('最終反映payloadは複数の対応付けと未選択承認を受け付ける', () => {
  const parsed = parseOrderListConfirmPayload({
    mappings: [
      { item_id: 'item-1', db_card_id: 'card-1' },
      { item_id: 'item-2', db_card_id: 'card-2' },
    ],
    new_cards: [{
      item_id: 'item-3', card_name: ' 新商品 ', grade: ' PSA10 ', list_no: ' 001 ', tag: ' TOP ',
      alt_image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/new.png',
    }],
    exclusions: [{ item_id: 'item-4' }],
    allow_unresolved: true,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    mappings: [
      { item_id: 'item-1', db_card_id: 'card-1' },
      { item_id: 'item-2', db_card_id: 'card-2' },
    ],
    newCards: [{
      item_id: 'item-3', card_name: '新商品', grade: 'PSA10', list_no: '001', tag: 'TOP',
      alt_image_url: 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/new.png',
    }],
    exclusions: [{ item_id: 'item-4' }],
    allowUnresolved: true,
  });
});

test('only definitive Cloud Run rejections may release the launch lease', () => {
  for (const code of [3, 5, 7, 9, 12, 16]) {
    assert.equal(isDefinitiveCloudRunJobRejection({ code }), true);
  }
  for (const code of [1, 2, 4, 8, 10, 13, 14, 15]) {
    assert.equal(isDefinitiveCloudRunJobRejection({ code }), false);
  }
  assert.equal(isDefinitiveCloudRunJobRejection(new Error('network disconnected')), false);
  assert.equal(isDefinitiveCloudRunJobRejection({ code: '7' }), false);
});

test('一括対応付けpayloadは同じitem_idの重複を拒否する', () => {
  const parsed = parseOrderListMappingSelections([
    { item_id: 'item-1', db_card_id: 'card-1' },
    { item_id: 'item-1', db_card_id: 'card-2' },
  ]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /重複/);
});

test('取込上限の12,000件まで対応付けでき、超過は拒否する', () => {
  const atLimit = parseOrderListMappingSelections(Array.from(
    { length: 12_000 },
    (_, index) => ({ item_id: `item-${index}`, db_card_id: `card-${index}` }),
  ));
  assert.equal(atLimit.ok, true);

  const overLimit = parseOrderListMappingSelections(Array.from(
    { length: 12_001 },
    (_, index) => ({ item_id: `item-${index}`, db_card_id: `card-${index}` }),
  ));
  assert.equal(overLimit.ok, false);
  if (!overLimit.ok) assert.match(overLimit.error, /12000|12,000/);
});

test('再同期の内容指紋は配列順に依存せず内容変更を検出する', () => {
  const base = {
    mappings: [
      { item_id: 'item-b', db_card_id: 'card-b' },
      { item_id: 'item-a', db_card_id: 'card-a' },
    ],
    newCards: [],
    exclusions: [{ item_id: 'item-c' }],
    allowUnresolved: true,
  };
  const reordered = {
    ...base,
    mappings: [...base.mappings].reverse(),
  };
  assert.equal(orderListSyncRequestFingerprint(base), orderListSyncRequestFingerprint(reordered));
  assert.notEqual(
    orderListSyncRequestFingerprint(base),
    orderListSyncRequestFingerprint({ ...base, allowUnresolved: false }),
  );
});

test('再同期payloadは操作単位のUUIDを必須にする', () => {
  const valid = parseOrderListResyncPayload({
    request_id: '550e8400-e29b-41d4-a716-446655440000',
    allow_unresolved: true,
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.requestId, '550e8400-e29b-41d4-a716-446655440000');
  }

  const missing = parseOrderListResyncPayload({});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /request_id.*UUID/);

  const invalid = parseOrderListResyncPayload({ request_id: 'same-click' });
  assert.equal(invalid.ok, false);
});

test('空body互換のconfirm payloadは選択なし・未承認として扱う', () => {
  const parsed = parseOrderListConfirmPayload({});

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { mappings: [], newCards: [], exclusions: [], allowUnresolved: false });
});

test('買取表対象外payloadは重複と3処理合計上限を検証する', () => {
  const duplicate = parseOrderListExclusionSelections([
    { item_id: 'item-1' },
    { item_id: 'item-1' },
  ]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /重複/);

  const crossDuplicate = parseOrderListSelectionsPayload({
    mappings: [{ item_id: 'item-1', db_card_id: 'card-1' }],
    exclusions: [{ item_id: 'item-1' }],
  });
  assert.equal(crossDuplicate.ok, false);
  if (!crossDuplicate.ok) assert.match(crossDuplicate.error, /複数の処理/);

  const aggregateOverLimit = parseOrderListSelectionsPayload({
    mappings: Array.from(
      { length: 6_000 },
      (_, index) => ({ item_id: `mapped-${index}`, db_card_id: `card-${index}` }),
    ),
    exclusions: Array.from(
      { length: 6_001 },
      (_, index) => ({ item_id: `excluded-${index}` }),
    ),
  });
  assert.equal(aggregateOverLimit.ok, false);
  if (!aggregateOverLimit.ok) assert.match(aggregateOverLimit.error, /12000|12,000/);
});

test('新規DB商品は必須タグと許可済みHTTPS代替画像を検証する', () => {
  const missingTag = parseOrderListNewCardSelections([{
    item_id: 'item-1', card_name: '新商品', grade: '', list_no: '', tag: '', alt_image_url: null,
  }]);
  assert.equal(missingTag.ok, false);
  if (!missingTag.ok) assert.match(missingTag.error, /タグは必須/);

  const unsafeUrl = parseOrderListNewCardSelections([{
    item_id: 'item-1', card_name: '新商品', grade: '', list_no: '', tag: '通常',
    alt_image_url: 'https://127.0.0.1/internal.png',
  }]);
  assert.equal(unsafeUrl.ok, false);
  if (!unsafeUrl.ok) assert.match(unsafeUrl.error, /許可された画像ホスト/);

  const unsafePort = parseOrderListNewCardSelections([{
    item_id: 'item-1', card_name: '新商品', grade: '', list_no: '', tag: '通常',
    alt_image_url: 'https://fexadnveyuqduiujewrc.supabase.co:444/internal.png',
  }]);
  assert.equal(unsafePort.ok, false);
  if (!unsafePort.ok) assert.match(unsafePort.error, /許可された画像ホスト/);
});

test('同じitem_idを既存DB対応と新規DB商品の両方には指定できない', () => {
  const parsed = parseOrderListSelectionsPayload({
    mappings: [{ item_id: 'item-1', db_card_id: 'card-1' }],
    new_cards: [{
      item_id: 'item-1', card_name: '新商品', grade: '', list_no: '', tag: '通常', alt_image_url: null,
    }],
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /複数の処理に指定できません/);
});
