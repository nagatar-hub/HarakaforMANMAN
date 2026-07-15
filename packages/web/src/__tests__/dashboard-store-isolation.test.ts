jest.mock('server-only', () => ({}), { virtual: true });

import { loadDashboardData } from '../lib/dashboard-data';
import { STORE_NAME } from '../lib/store';

type DashboardClient = NonNullable<Parameters<typeof loadDashboardData>[0]>;

function chain<T extends object>(terminal: T) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    ...terminal,
  };
}

describe('dashboard store isolation', () => {
  test('uses the server-owned MANMAN identity even if a public value disagrees', () => {
    process.env.NEXT_PUBLIC_STORE_NAME = 'oripark';
    expect(STORE_NAME).toBe('manman');
  });

  test('scopes the parent run before reading rows derived from its ID', async () => {
    const run = {
      id: 'owned-run',
      store: 'manman',
      status: 'completed',
      started_at: '2026-07-15T00:00:00.000Z',
    };
    const runQuery = chain({
      maybeSingle: jest.fn().mockResolvedValue({ data: run }),
    });
    const preparedQuery = chain({
      is: jest.fn().mockResolvedValue({ count: 2 }),
    });
    const generatedQuery = chain({
      limit: jest.fn().mockResolvedValue({
        data: [{ id: 'page-1', franchise: 'pokemon', page_label: '1', image_url: null }],
      }),
    });
    const from = jest.fn((table: string) => {
      if (table === 'run') return runQuery;
      if (table === 'prepared_card') return preparedQuery;
      if (table === 'generated_page') return generatedQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const result = await loadDashboardData({ from } as unknown as DashboardClient);

    expect(runQuery.eq).toHaveBeenCalledWith('store', 'manman');
    expect(preparedQuery.eq).toHaveBeenCalledWith('run_id', 'owned-run');
    expect(generatedQuery.eq).toHaveBeenCalledWith('run_id', 'owned-run');
    expect(result.untaggedCount).toBe(2);
    expect(result.recentPages).toHaveLength(1);
  });

  test('does not query derived tables when this store has no run', async () => {
    const runQuery = chain({
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
    });
    const from = jest.fn(() => runQuery);

    const result = await loadDashboardData({ from } as unknown as DashboardClient);

    expect(runQuery.eq).toHaveBeenCalledWith('store', 'manman');
    expect(from).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ run: null, untaggedCount: 0, recentPages: [] });
  });
});
