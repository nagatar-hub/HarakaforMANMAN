/**
 * OAuth 認証ヘルパー
 *
 * sync / generate 両ジョブで共通利用
 */

import { refreshAccessToken } from './google-sheets.js';

export interface OAuthCredentials {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth 認証情報を取得する。
 * ローカル: .env から読み込み
 * Cloud Run: Secret Manager から読み込み
 */
export async function getCredentials(): Promise<OAuthCredentials> {
  // ローカル開発: .env に値がある場合はそれを使用
  if (process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }

  // Cloud Run: Secret Manager から取得
  const { getSecret } = await import('./secret-manager.js');
  const [refreshToken, clientId, clientSecret] = await Promise.all([
    getSecret('haraka-oauth-refresh-token'),
    getSecret('haraka-oauth-client-id'),
    getSecret('haraka-oauth-client-secret'),
  ]);
  return { refreshToken, clientId, clientSecret };
}

/**
 * 認証情報を取得し、access token を返す
 */
export async function getAccessToken(): Promise<string> {
  const creds = await getCredentials();
  return refreshAccessToken(creds);
}
