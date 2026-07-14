import { runWatchdog } from '../jobs/watchdog';
import { createSupabaseClientFromSecrets } from '../lib/supabase';
import { runCloudRunJob } from '../lib/cloud-run';
import { sendDiscordNotification } from '../lib/discord';

jest.mock('../lib/supabase.js', () => ({
  createSupabaseClientFromSecrets: jest.fn(),
}));

jest.mock('../lib/cloud-run.js', () => ({
  fetchMetadataAccessToken: jest.fn(async () => 'metadata-token'),
  runCloudRunJob: jest.fn(async () => undefined),
}));

jest.mock('../lib/discord.js', () => ({
  COLOR: {
    ERROR: 0xff0000,
    SUCCESS: 0x00ff00,
    WARNING: 0xffff00,
  },
  sendDiscordNotification: jest.fn(async () => undefined),
}));

type RunRow = {
  id: string;
  store: string;
  triggered_by: string;
  order_list_import_id: string | null;
  status: string;
  started_at: string;
  generate_done_at: string | null;
  postal_done_at: string | null;
  store_done_at: string | null;
  error_message: string | null;
};

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-1',
    store: 'oripark',
    triggered_by: 'scheduler',
    order_list_import_id: 'import-1',
    status: 'completed',
    started_at: '2026-05-31T00:10:00.000Z',
    generate_done_at: null,
    postal_done_at: null,
    store_done_at: null,
    error_message: null,
    ...overrides,
  };
}

function makeSupabase(rows: RunRow[]) {
  return {
    from(table: string) {
      if (table !== 'run') throw new Error(`Unexpected table: ${table}`);

      const filters: Array<{ column: string; value: unknown; op: 'eq' | 'gte' | 'not-is' }> = [];
      let limitValue: number | undefined;

      type Query = {
        select: jest.Mock<Query, []>;
        eq: jest.Mock<Query, [string, unknown]>;
        not: jest.Mock<Query, [string, string, unknown]>;
        gte: jest.Mock<Query, [string, unknown]>;
        order: jest.Mock<Query, []>;
        limit: jest.Mock<Query, [number]>;
        returns: jest.Mock<Promise<{ data: RunRow[]; error: null }>, []>;
        single: jest.Mock<Promise<{ data: RunRow | null; error: null }>, []>;
      };

      const query = {} as Query;
      query.select = jest.fn(() => query);
      query.eq = jest.fn((column: string, value: unknown) => {
          filters.push({ column, value, op: 'eq' });
          return query;
        });
      query.not = jest.fn((column: string, operator: string, value: unknown) => {
          filters.push({ column, value, op: operator === 'is' ? 'not-is' : 'eq' });
          return query;
        });

      query.gte = jest.fn((column: string, value: unknown) => {
          filters.push({ column, value, op: 'gte' });
          return query;
        });
      query.order = jest.fn(() => query);
      query.limit = jest.fn((value: number) => {
          limitValue = value;
          return query;
        });
      query.returns = jest.fn(async () => ({ data: applyFilters(rows, filters, limitValue), error: null }));
      query.single = jest.fn(async () => ({ data: applyFilters(rows, filters, limitValue)[0] ?? null, error: null }));

      return query;
    },
  };
}

function applyFilters(rows: RunRow[], filters: Array<{ column: string; value: unknown; op: 'eq' | 'gte' | 'not-is' }>, limitValue?: number): RunRow[] {
  const filtered = rows.filter((row) => filters.every((filter) => {
    if (filter.op === 'not-is') {
      return row[filter.column as keyof RunRow] !== filter.value;
    }
    if (filter.op === 'eq') {
      return row[filter.column as keyof RunRow] === filter.value;
    }
    if (filter.column === 'started_at') {
      return row.started_at >= String(filter.value);
    }
    return true;
  }));
  return limitValue === undefined ? filtered : filtered.slice(0, limitValue);
}

describe('runWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T00:10:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('本日のオーダーリストRunが未生成ならExcel取込を促し、同期やgenerateを自動実行しない', async () => {
    const rows: RunRow[] = [];
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase(rows));

    await runWatchdog();

    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(sendDiscordNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: '⚠️ 本日のオーダーリスト未反映',
    }));
  });

  it('web-uiで反映した本日のオーダーリストRunを正常完了として認識する', async () => {
    const completedAt = '2026-05-31T00:09:00.000Z';
    const rows = [makeRun({
      triggered_by: 'web-ui',
      generate_done_at: completedAt,
      postal_done_at: completedAt,
      store_done_at: completedAt,
    })];
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase(rows));

    await runWatchdog();

    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(sendDiscordNotification).not.toHaveBeenCalled();
  });
});
