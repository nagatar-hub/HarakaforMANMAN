/**
 * リトライ・タイムアウト付き fetch ユーティリティ
 *
 * 指数バックオフでリトライし、AbortController でタイムアウトを制御する。
 * Google API の一時的な障害（429, 500, 502, 503, 504）に対応。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** 最大リトライ回数（デフォルト: 3） */
  maxRetries?: number;
  /** 初回リトライまでの待機ミリ秒（デフォルト: 1000） */
  baseDelayMs?: number;
  /** タイムアウトミリ秒（デフォルト: 30000） */
  timeoutMs?: number;
}

/** invalid_grant 等の認証エラーを識別するためのエラークラス */
export class OAuthInvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthInvalidGrantError';
  }
}

// ---------------------------------------------------------------------------
// リトライ対象の判定
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('abort')
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * リトライ・タイムアウト付きで fetch を実行する。
 *
 * - ネットワークエラーおよび HTTP 429/5xx をリトライ
 * - 認証エラー（401, 403）はリトライしない
 * - `invalid_grant` を検出した場合は OAuthInvalidGrantError をスロー
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: RetryConfig = {},
): Promise<Response> {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 1000;
  const timeoutMs = config.timeoutMs ?? 30_000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(
          `[fetchWithRetry] HTTP ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${url.substring(0, 120)}`,
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);

      lastError = err instanceof Error ? err : new Error(String(err));

      if (isRetryableError(err) && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(
          `[fetchWithRetry] Network error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error('fetchWithRetry: unexpected end of retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
