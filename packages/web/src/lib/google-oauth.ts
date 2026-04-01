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
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');
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
}): string {
  const searchParams = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

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
export function validateEnvVars(): Result<EnvVars> {
  const missing: string[] = [];

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl =
    process.env.NEXTAUTH_URL ?? DEFAULT_BASE_URL;

  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');

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
