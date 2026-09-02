import {
  GENERATE_CLAIM_LEASE_MS,
  isStaleGenerateClaim,
  runWatchdog,
} from '../jobs/watchdog';
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
  COLOR: { ERROR: 0xff0000, SUCCESS: 0x00ff00, WARNING: 0xffff00 },
  sendDiscordNotification: jest.fn(async () => undefined),
}));

type RunRow = {
  id: string;
  store: string;
  order_list_import_id: string | null;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  plan_done_at: string | null;
  generate_claimed_at: string | null;
  generate_claim_token: string | null;
  generate_done_at: string | null;
  error_message: string | null;
};

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-1',
    store: 'manman',
    order_list_import_id: 'import-1',
    status: 'completed',
    started_at: '2026-05-31T00:10:00.000Z',
    plan_done_at: '2026-05-31T00:05:00.000Z',
    generate_claimed_at: null,
    generate_claim_token: null,
    generate_done_at: null,
    error_message: null,
    ...overrides,
  };
}

type Filter = {
  column: keyof RunRow;
  value: unknown;
  op: 'eq' | 'in' | 'gte' | 'lte' | 'not-is' | 'is';
};

function applyFilters(rows: RunRow[], filters: Filter[], limit?: number): RunRow[] {
  const filtered = rows.filter(row => filters.every(filter => {
    const actual = row[filter.column];
    if (filter.op === 'not-is') return actual !== filter.value;
    if (filter.op === 'eq' || filter.op === 'is') return actual === filter.value;
    if (filter.op === 'in') return (filter.value as unknown[]).includes(actual);
    if (filter.op === 'gte') return String(actual) >= String(filter.value);
    return String(actual) <= String(filter.value);
  }));
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

function makeSupabase(
  rows: RunRow[],
  casMissIds = new Set<string>(),
  latestImportId: string | null | undefined = undefined,
) {
  return {
    from(table: string) {
      if (table === 'order_list_import') {
        const query: Record<string, jest.Mock> = {};
        for (const method of ['select', 'eq', 'order', 'limit']) {
          query[method] = jest.fn(() => query);
        }
        query.maybeSingle = jest.fn(async () => {
          const id = latestImportId === undefined ? rows[0]?.order_list_import_id : latestImportId;
          return { data: id ? { id } : null, error: null };
        });
        return query;
      }
      if (table !== 'run') throw new Error(`Unexpected table: ${table}`);
      const filters: Filter[] = [];
      let limit: number | undefined;
      let updates: Partial<RunRow> | undefined;
      const execute = async (single: boolean) => {
        const matched = applyFilters(rows, filters, single ? 1 : limit);
        const id = filters.find(filter => filter.column === 'id' && filter.op === 'eq')?.value;
        if (single && typeof id === 'string' && casMissIds.has(id)) return { data: null, error: null };
        if (updates) matched.forEach(row => Object.assign(row, updates));
        return { data: single ? (matched[0] ?? null) : matched, error: null };
      };
      const query: Record<string, jest.Mock | ((...args: never[]) => Promise<unknown>)> = {};
      query.select = jest.fn(() => query);
      query.update = jest.fn((values: Partial<RunRow>) => { updates = values; return query; });
      query.eq = jest.fn((column: keyof RunRow, value: unknown) => {
        filters.push({ column, value, op: 'eq' }); return query;
      });
      query.in = jest.fn((column: keyof RunRow, value: unknown[]) => {
        filters.push({ column, value, op: 'in' }); return query;
      });
      query.not = jest.fn((column: keyof RunRow, operator: string, value: unknown) => {
        filters.push({ column, value, op: operator === 'is' ? 'not-is' : 'eq' }); return query;
      });
      query.is = jest.fn((column: keyof RunRow, value: unknown) => {
        filters.push({ column, value, op: 'is' }); return query;
      });
      query.gte = jest.fn((column: keyof RunRow, value: unknown) => {
        filters.push({ column, value, op: 'gte' }); return query;
      });
      query.lte = jest.fn((column: keyof RunRow, value: unknown) => {
        filters.push({ column, value, op: 'lte' }); return query;
      });
      query.order = jest.fn(() => query);
      query.limit = jest.fn((value: number) => { limit = value; return query; });
      query.returns = jest.fn(() => execute(false));
      query.maybeSingle = jest.fn(() => execute(true));
      return query;
    },
  };
}

function getLaunchEnv(): Array<{ name: string; value: string }> {
  return (runCloudRunJob as jest.Mock).mock.calls.at(-1)?.[0].containerOverrides[0].env;
}

describe('runWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T00:10:00.000Z'));
    jest.clearAllMocks();
    delete process.env.WATCHDOG_MODE;
  });

  afterEach(() => {
    delete process.env.WATCHDOG_MODE;
    jest.useRealTimers();
  });

  it('本日のRunがなければExcel取込を促す', async () => {
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase([]));
    await runWatchdog();
    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(sendDiscordNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: '⚠️ 本日のオーダーリスト未反映',
    }));
  });

  it('最新取込にRunがなければ同日の古いRunへフォールバックしない', async () => {
    const oldRun = makeRun({ id: 'old-run', order_list_import_id: 'old-import' });
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(
      makeSupabase([oldRun], new Set(), 'failed-latest-import'),
    );

    await runWatchdog();

    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(oldRun.status).toBe('completed');
  });

  it('WATCHDOG_MODE=recoveryなら全期間回収だけで終了する', async () => {
    process.env.WATCHDOG_MODE = 'recovery';
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase([]));
    await runWatchdog();
    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(sendDiscordNotification).not.toHaveBeenCalled();
  });

  it('前日以前のstale claimをold tokenとold claimed_atのCASで更新し単一タスクを再起動する', async () => {
    process.env.WATCHDOG_MODE = 'recovery';
    const stale = makeRun({
      id: 'run-yesterday',
      status: 'running',
      started_at: '2026-05-29T00:00:00.000Z',
      generate_claimed_at: '2026-05-30T22:54:59.000Z',
      generate_claim_token: 'old-token',
    });
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase([stale]));

    await runWatchdog();

    expect(runCloudRunJob).toHaveBeenCalledTimes(1);
    expect(stale.generate_claimed_at).toBe('2026-05-31T00:10:00.000Z');
    expect(stale.generate_claim_token).not.toBe('old-token');
    expect(getLaunchEnv()).toEqual([
      { name: 'RUN_ID', value: stale.id },
      { name: 'GENERATE_CLAIM_TOKEN', value: stale.generate_claim_token },
      { name: 'STORE_NAME', value: 'manman' },
    ]);
  });

  it('stale claimのCAS競合に負けた場合は再起動しない', async () => {
    process.env.WATCHDOG_MODE = 'recovery';
    const stale = makeRun({
      id: 'run-cas-lost',
      status: 'running',
      started_at: '2026-05-29T00:00:00.000Z',
      generate_claimed_at: '2026-05-30T22:00:00.000Z',
      generate_claim_token: 'old-token',
    });
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(
      makeSupabase([stale], new Set([stale.id])),
    );

    await runWatchdog();

    expect(runCloudRunJob).not.toHaveBeenCalled();
    expect(stale.generate_claim_token).toBe('old-token');
  });

  it('本日の画像生成済みRunは再起動しない', async () => {
    const rows = [makeRun({ generate_done_at: '2026-05-31T00:09:00.000Z' })];
    (createSupabaseClientFromSecrets as jest.Mock).mockResolvedValue(makeSupabase(rows));
    await runWatchdog();
    expect(runCloudRunJob).not.toHaveBeenCalled();
  });
});

describe('isStaleGenerateClaim', () => {
  const now = new Date('2026-05-31T00:10:00.000Z');

  it('75分境界からstaleと判定する', () => {
    const claimedAt = new Date(now.getTime() - GENERATE_CLAIM_LEASE_MS).toISOString();
    expect(isStaleGenerateClaim(makeRun({ status: 'running', generate_claimed_at: claimedAt }), now)).toBe(true);
  });

  it('fresh、claimなし、生成済みはstaleにしない', () => {
    expect(isStaleGenerateClaim(makeRun({ status: 'running' }), now)).toBe(false);
    expect(isStaleGenerateClaim(makeRun({
      status: 'running',
      generate_claimed_at: '2026-05-30T23:10:01.000Z',
    }), now)).toBe(false);
    expect(isStaleGenerateClaim(makeRun({
      status: 'running',
      generate_claimed_at: '2026-05-30T22:00:00.000Z',
      generate_done_at: '2026-05-30T23:00:00.000Z',
    }), now)).toBe(false);
  });
});
