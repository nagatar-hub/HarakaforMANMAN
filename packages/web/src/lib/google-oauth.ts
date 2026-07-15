/**
 * Google OAuth 2.0 ユーティリティ
 *
 * Google Sheets API 用の refresh token を取得するためのヘルパー関数群。
 * 外部ライブラリに依存せず、fetch API のみを使用。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token?: string;
}

export interface GoogleErrorResponse {
  error: string;
  error_description?: string;
}

/** Result 型 — エラーを例外ではなく戻り値で扱う */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface EnvVars {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
// spreadsheets は read+write。Haraka DB シートへの append/update に書き込みが必要。
const SHEET_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');
const OPERATOR_OAUTH_SCOPES = 'openid email';
const DEFAULT_BASE_URL = 'http://localhost:3001';

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * Google OAuth 認証 URL を生成する。
 *
 * - access_type=offline: refresh_token を取得するため
 * - prompt=consent: 毎回 refresh_token を確実に取得するため
 */
export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state?: string;
  mode?: 'sheet' | 'operator';
}): string {
  const mode = params.mode ?? 'sheet';
  const searchParams = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: mode === 'operator' ? OPERATOR_OAUTH_SCOPES : SHEET_OAUTH_SCOPES,
  });

  // Sheet OAuth still needs a refresh token. Operator login only requests
  // identity and must never request or persist offline access.
  if (mode === 'sheet') {
    searchParams.set('access_type', 'offline');
    searchParams.set('prompt', 'consent');
  } else {
    searchParams.set('prompt', 'select_account');
  }

  if (params.state) {
    searchParams.set('state', params.state);
  }

  return `${GOOGLE_AUTH_ENDPOINT}?${searchParams.toString()}`;
}

/**
 * token endpoint に送る application/x-www-form-urlencoded ボディを構築する。
 */
export function buildTokenRequestBody(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  }).toString();
}

/**
 * Google token レスポンスから refresh_token を取り出す。
 * 存在しない場合は null を返す。
 */
export function extractRefreshToken(
  response: GoogleTokenResponse
): string | null {
  return response.refresh_token ?? null;
}

/**
 * 必須環境変数の存在を検証し、値を返す。
 * 不足している場合は変数名を含むエラーメッセージを返す。
 */
export function validateEnvVars(headers?: Headers): Result<EnvVars> {
  const missing: string[] = [];

  // The web UI and operator login intentionally share one Google OAuth client.
  // GOOGLE_CLIENT_* remains a compatibility fallback for existing deployments.
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()
    || process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()
    || process.env.GOOGLE_CLIENT_SECRET?.trim();

  // OAuth redirect_uri must come from a trusted configured origin in
  // production. Forwarded headers are request-controlled in some proxy
  // deployments, so they are considered only for localhost development.
  let baseUrl = DEFAULT_BASE_URL;
  const configuredBaseUrl = process.env.NEXTAUTH_URL?.trim();
  if (configuredBaseUrl) {
    try {
      const parsed = new URL(configuredBaseUrl);
      const isLocalhost = parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]';
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        || (parsed.protocol === 'http:' && !isLocalhost)
        || parsed.username
        || parsed.password
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash) {
        throw new Error('untrusted OAuth base URL');
      }
      baseUrl = parsed.origin;
    } catch {
      return {
        ok: false,
        error: 'NEXTAUTH_URL must be a trusted HTTPS origin without a path, query, or hash',
      };
    }
  } else if (process.env.NODE_ENV === 'production') {
    missing.push('NEXTAUTH_URL');
  } else if (headers) {
    const host = headers.get('x-forwarded-host') || headers.get('host');
    const proto = headers.get('x-forwarded-proto') || 'http';
    if (host && (proto === 'http' || proto === 'https')) {
      try {
        const inferred = new URL(`${proto}://${host}`);
        if (inferred.hostname === 'localhost'
          || inferred.hostname === '127.0.0.1'
          || inferred.hostname === '[::1]') {
          baseUrl = inferred.origin;
        }
      } catch {
        // Keep the fixed localhost default for malformed development headers.
      }
    }
  }

  if (!clientId) missing.push('GOOGLE_OAUTH_CLIENT_ID or GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_OAUTH_CLIENT_SECRET or GOOGLE_CLIENT_SECRET');

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required environment variables: ${missing.join(', ')}`,
    };
  }

  return {
    ok: true,
    value: {
      clientId: clientId!,
      clientSecret: clientSecret!,
      baseUrl,
    },
  };
}

/**
 * Google OAuth token endpoint に認可コードを送ってトークンを取得する。
 * fetch を直接呼ぶ部分はここに集約し、Route Handler から分離する。
 */
export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<Result<GoogleTokenResponse>> {
  const body = buildTokenRequestBody(params);

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }

  const data: unknown = await response.json();

  if (!response.ok) {
    const errorData = data as GoogleErrorResponse;
    return {
      ok: false,
      error: `Token exchange failed: ${errorData.error} — ${errorData.error_description ?? ''}`.trim(),
    };
  }

  return { ok: true, value: data as GoogleTokenResponse };
}
