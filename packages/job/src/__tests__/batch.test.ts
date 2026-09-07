import { batchInsert, batchUpsert } from '../lib/batch.js';

test('Supabase from is called with its client context', async () => {
  const calls: string[] = [];
  const client = {
    rest: true,
    from(this: { rest?: boolean }, table: string) {
      if (!this.rest) throw new Error('client context was lost');
      return {
        insert: async () => { calls.push(`insert:${table}`); return { error: null }; },
        upsert: async () => { calls.push(`upsert:${table}`); return { error: null }; },
      };
    },
  };

  await batchInsert(client as never, 'raw_import', [{ id: 1 }]);
  await batchUpsert(client as never, 'db_card', [{ id: 2 }], 'id');
  expect(calls).toEqual(['insert:raw_import', 'upsert:db_card']);
});
