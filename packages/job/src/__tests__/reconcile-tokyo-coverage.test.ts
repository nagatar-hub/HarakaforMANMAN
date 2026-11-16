import { reconcileTokyoCoverage } from '../jobs/reconcile-tokyo-coverage';
import { loadOriparkCoverage } from '../lib/oripark-coverage';
import { runCloudRunJob } from '../lib/cloud-run';

jest.mock('../lib/oripark-coverage.js', () => ({
  loadOriparkCoverage: jest.fn(),
  readCoverageReport: (report: any) => report?.oripark_coverage ?? null,
}));
jest.mock('../lib/cloud-run.js', () => ({ runCloudRunJob: jest.fn(), fetchMetadataAccessToken: jest.fn() }));

const now = new Date('2026-11-16T15:10:00Z'); // Nov 17 JST: previous day's import is still fresh.
function database(options: { status?: string; date?: string; run?: Record<string, unknown>; fingerprint?: string; action?: string; queueError?: any } = {}) {
  const queries: { table: string; filters: [string, unknown][] }[] = [];
  const rows: Record<string, unknown> = {
    order_list_import: { id: 'import', status: options.status ?? 'applied', business_date: options.date ?? '2026-11-16' },
    run: { id: 'tokyo-run', status: 'completed', plan_done_at: 'ready', generate_done_at: 'done', tokyo_snapshot_id: 'snapshot', ...options.run },
    tokyo_buyback_snapshot: { report: { oripark_coverage: { fingerprint: options.fingerprint ?? 'old' } } },
  };
  const db = {
    rpc: jest.fn(async () => ({ data: { action: options.action ?? 'start_job' }, error: options.queueError ?? null })),
    from(table: string) {
      const filters: [string, unknown][] = [];
      queries.push({ table, filters });
      const query: any = {};
      for (const method of ['select', 'order', 'limit']) query[method] = () => query;
      query.eq = (key: string, value: unknown) => { filters.push([key, value]); return query; };
      query.single = query.maybeSingle = async () => ({ data: rows[table], error: null });
      return query;
    },
  };
  return { db, queries };
}
beforeEach(() => {
  jest.clearAllMocks();
  (loadOriparkCoverage as jest.Mock).mockResolvedValue({ runId: 'oripark-run', fingerprint: 'current' });
  (runCloudRunJob as jest.Mock).mockResolvedValue(undefined);
});

test('late Oripark publication queues the latest Tokyo import with a stable lease, even across midnight', async () => {
  const { db, queries } = database();
  expect(await reconcileTokyoCoverage(db as any, now)).toBe(true);
  const first = db.rpc.mock.calls[0];
  await reconcileTokyoCoverage(db as any, now);
  expect(db.rpc.mock.calls[1]).toEqual(first);
  expect(queries.find(q => q.table === 'run')?.filters).toContainEqual(['order_list_import_id', 'import']);
  const env = (runCloudRunJob as jest.Mock).mock.calls[0][0].containerOverrides[0].env;
  expect(env).toContainEqual({ name: 'ORDER_LIST_IMPORT_ID', value: 'import' });
  expect(env).toContainEqual({ name: 'DISCORD_NOTIFICATIONS_DISABLED', value: 'true' });
});

test.each([
  { fingerprint: 'current' }, { date: '2026-11-14' }, { status: 'processing' },
  { run: { status: 'running' } }, { run: { generate_done_at: null } },
])('unchanged, stale or active work does not queue another sync: %j', async options => {
  const { db } = database(options);
  expect(await reconcileTokyoCoverage(db as any, now)).toBe(false);
  expect(db.rpc).not.toHaveBeenCalled();
  expect(runCloudRunJob).not.toHaveBeenCalled();
});

test('a failed sync is retried using a new run lease while the source date is fresh', async () => {
  const { db } = database({ status: 'failed', run: { id: 'failed-run', status: 'failed', plan_done_at: null, generate_done_at: null, tokyo_snapshot_id: null } });
  expect(await reconcileTokyoCoverage(db as any, now)).toBe(true);
  expect(runCloudRunJob).toHaveBeenCalledTimes(1);
});

test.each([{ action: 'noop' }, { queueError: { code: '55000', message: 'lease owned' } }])(
  'an existing lease never launches a second worker: %j', async options => {
    const { db } = database(options);
    expect(await reconcileTokyoCoverage(db as any, now)).toBe(true);
    expect(runCloudRunJob).not.toHaveBeenCalled();
  });

test('a launch failure remains retryable with the same request identity', async () => {
  const { db } = database({ status: 'confirmed' });
  (runCloudRunJob as jest.Mock).mockRejectedValueOnce(new Error('network'));
  await expect(reconcileTokyoCoverage(db as any, now)).rejects.toThrow('network');
  await reconcileTokyoCoverage(db as any, now);
  expect(db.rpc.mock.calls[0]).toEqual(db.rpc.mock.calls[1]);
});
