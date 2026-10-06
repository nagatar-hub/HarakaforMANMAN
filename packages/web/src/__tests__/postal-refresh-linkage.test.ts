import { refreshTokyoPostalPages } from '../lib/postal-refresh';

const runId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test('starts and polls the run-scoped refresh through success', async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce(response(202, { requestId }))
    .mockResolvedValueOnce(response(200, { request_id: requestId, status: 'running' }))
    .mockResolvedValueOnce(response(200, { request_id: requestId, status: 'succeeded', page_count: 2 }));
  await expect(refreshTokyoPostalPages(runId, {
    fetcher, wait: async () => {}, maxAttempts: 3,
  })).resolves.toEqual({ pageCount: 2 });
  expect(fetcher.mock.calls[0]).toEqual([
    `/api/backend/api/gallery/runs/${runId}/postal/refresh`, { method: 'POST' },
  ]);
  expect(fetcher.mock.calls.slice(1).every(call => call.length === 1)).toBe(true);
});

test('surfaces a failed refresh', async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce(response(202, { requestId }))
    .mockResolvedValueOnce(response(200, {
      request_id: requestId, status: 'failed', error_message: 'Peleka同期完了後に再試行してください',
    }));
  await expect(refreshTokyoPostalPages(runId, {
    fetcher, wait: async () => {}, maxAttempts: 1,
  })).rejects.toThrow('Peleka同期完了後に再試行してください');
});

test('reports a successful zero-page replacement', async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce(response(202, { requestId }))
    .mockResolvedValueOnce(response(200, { request_id: requestId, status: 'succeeded', page_count: 0 }));
  await expect(refreshTokyoPostalPages(runId, {
    fetcher, wait: async () => {}, maxAttempts: 1,
  })).resolves.toEqual({ pageCount: 0 });
});

test('resumes polling the existing running request after reload', async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce(response(409, { error: 'この実行分の郵送表は更新中です' }))
    .mockResolvedValueOnce(response(200, { request_id: requestId, status: 'running' }))
    .mockResolvedValueOnce(response(200, { request_id: requestId, status: 'succeeded', page_count: 1 }));
  await expect(refreshTokyoPostalPages(runId, {
    fetcher, wait: async () => {}, maxAttempts: 1,
  })).resolves.toEqual({ pageCount: 1 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test('posts first so an expired running claim can be reclaimed and follows only the new request', async () => {
  const newRequestId = '20000000-0000-4000-8000-000000000002';
  const fetcher = jest.fn()
    .mockResolvedValueOnce(response(202, { requestId: newRequestId }))
    .mockResolvedValueOnce(response(200, {
      request_id: newRequestId, status: 'succeeded', page_count: 2,
    }));
  await expect(refreshTokyoPostalPages(runId, {
    fetcher, wait: async () => {}, maxAttempts: 1,
  })).resolves.toEqual({ pageCount: 2 });
  expect(fetcher.mock.calls[0][1]).toEqual({ method: 'POST' });
  expect(fetcher.mock.calls[1][1]).toBeUndefined();
});
