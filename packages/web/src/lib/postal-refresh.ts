type FetchLike = typeof fetch;

type RefreshProgress = {
  request_id?: string;
  status?: string;
  page_count?: number | null;
  error_message?: string | null;
};

const API_URL = '/api/backend';

async function responseJson(response: Response): Promise<any> {
  return response.json().catch(() => null);
}

export async function refreshTokyoPostalPages(
  runId: string,
  options: { fetcher?: FetchLike; wait?: (ms: number) => Promise<void>; maxAttempts?: number } = {},
): Promise<{ pageCount: number }> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 240;
  const url = `${API_URL}/api/gallery/runs/${runId}/postal/refresh`;
  const start = await fetcher(url, { method: 'POST' });
  const started = await responseJson(start);
  let requestId = started?.requestId as string | undefined;

  if (!start.ok) {
    if (start.status !== 409) {
      throw new Error(started?.error || 'この実行分の郵送表更新を開始できませんでした');
    }
    const current = await fetcher(url);
    const progress = await responseJson(current) as RefreshProgress | null;
    if (!current.ok || progress?.status !== 'running' || !progress.request_id) {
      throw new Error(progress?.error_message || started?.error || '更新中の郵送表を確認できませんでした');
    }
    requestId = progress.request_id;
  }
  if (!requestId) throw new Error('郵送表更新の受付番号を確認できませんでした');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 || start.ok) await wait(5000);
    const check = await fetcher(url);
    if (!check.ok) continue;
    const progress = await responseJson(check) as RefreshProgress;
    if (progress.request_id !== requestId) {
      throw new Error('別の郵送表更新が開始されました。画面を再読み込みしてください');
    }
    if (progress.status === 'succeeded') return { pageCount: Number(progress.page_count ?? 0) };
    if (progress.status === 'failed') {
      throw new Error(progress.error_message || 'この実行分の郵送表更新に失敗しました');
    }
  }
  throw new Error('更新状況を確認できません。再読み込み後に状態を確認してください');
}
