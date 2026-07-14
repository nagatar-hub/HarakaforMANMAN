/**
 * リトライ・タイムアウト付き fetch ユーティリティ（API 用）
 *
 * 指数バックオフでリトライし、AbortController でタイムアウトを制御する。
 */

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: { maxRetries?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 1000;
  const timeoutMs = config.timeoutMs ?? 30_000;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[fetchWithRetry] HTTP ${response.status}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[fetchWithRetry] Error, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error('fetchWithRetry: unexpected end');
}
