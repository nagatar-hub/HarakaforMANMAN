import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  orderListImportRoutes,
  parseOrderListConfirmPayload,
  parseOrderListMappingSelections,
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



test('最終反映payloadは複数の対応付けと未選択承認を受け付ける', () => {
  const parsed = parseOrderListConfirmPayload({
    mappings: [
      { item_id: 'item-1', db_card_id: 'card-1' },
      { item_id: 'item-2', db_card_id: 'card-2' },
    ],
    allow_unresolved: true,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    mappings: [
      { item_id: 'item-1', db_card_id: 'card-1' },
      { item_id: 'item-2', db_card_id: 'card-2' },
    ],
    allowUnresolved: true,
  });
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

test('空body互換のconfirm payloadは選択なし・未承認として扱う', () => {
  const parsed = parseOrderListConfirmPayload({});

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { mappings: [], allowUnresolved: false });
});