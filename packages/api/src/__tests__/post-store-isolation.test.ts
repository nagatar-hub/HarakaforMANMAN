import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getOwnedPostAsset,
  getOwnedPostItem,
  getOwnedPostPlan,
  getOwnedRun,
  hasForbiddenFields,
  pickAllowedFields,
  STORE_NAME,
} from '../lib/store-scope.js';

type Row = Record<string, unknown>;

function createFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          const data = (tables[table] || []).find(row => (
            filters.every(([column, value]) => row[column] === value)
          )) || null;
          return { data, error: null };
        },
      };
      return query;
    },
  };
}

const OTHER_STORE = STORE_NAME === 'oripark' ? 'manman' : 'oripark';

function sharedRows() {
  return {
    run: [
      { id: 'run-owned', store: STORE_NAME },
      { id: 'run-other', store: OTHER_STORE },
    ],
    post_plan: [
      { id: 'plan-owned', run_id: 'run-owned', store: STORE_NAME },
      { id: 'plan-other', run_id: 'run-other', store: OTHER_STORE },
    ],
  };
}

test('run and post plan IDs from the other store are rejected as missing', async () => {
  const supabase = createFakeSupabase(sharedRows());

  assert.equal((await getOwnedRun(supabase as any, 'run-owned'))?.id, 'run-owned');
  assert.equal(await getOwnedRun(supabase as any, 'run-other'), null);
  assert.equal((await getOwnedPostPlan(supabase as any, 'plan-owned'))?.id, 'plan-owned');
  assert.equal(await getOwnedPostPlan(supabase as any, 'plan-other'), null);
});

test('items and assets inherit isolation from their parent plan and run', async () => {
  const supabase = createFakeSupabase({
    ...sharedRows(),
    post_item: [
      { id: 'item-owned', post_plan_id: 'plan-owned' },
      { id: 'item-other', post_plan_id: 'plan-other' },
    ],
    post_item_asset: [
      { id: 'asset-owned', post_item_id: 'item-owned' },
      { id: 'asset-other', post_item_id: 'item-other' },
    ],
  });

  assert.equal((await getOwnedPostItem(supabase as any, 'item-owned'))?.id, 'item-owned');
  assert.equal(await getOwnedPostItem(supabase as any, 'item-other'), null);
  assert.equal((await getOwnedPostAsset(supabase as any, 'asset-owned'))?.id, 'asset-owned');
  assert.equal(await getOwnedPostAsset(supabase as any, 'asset-other'), null);
});

test('PATCH whitelist rejects store, run_id and post_plan_id reparenting', () => {
  const body = {
    header_text: 'updated header',
    tweet_text: 'updated post',
    store: OTHER_STORE,
    run_id: 'run-other',
    post_plan_id: 'plan-other',
  };

  assert.equal(hasForbiddenFields(body, ['store', 'run_id', 'post_plan_id']), true);
  assert.deepEqual(pickAllowedFields(body, ['header_text']), { header_text: 'updated header' });
  assert.deepEqual(pickAllowedFields(body, ['tweet_text']), { tweet_text: 'updated post' });
});
