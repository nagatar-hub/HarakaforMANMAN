/**
 * GET /api/auth/google
 *
 * Google OAuth 認証フローの開始エンドポイント。
 * Google の認証ページにリダイレクトする。
 *
 * 必要な環境変数:
 *   GOOGLE_CLIENT_ID     — Google Cloud Console で発行したクライアント ID
 *   GOOGLE_CLIENT_SECRET — Google Cloud Console で発行したクライアントシークレット
 *   NEXTAUTH_URL         — このアプリのベース URL（省略時: http://localhost:3001）
 */

import { NextResponse } from 'next/server';
import { buildAuthorizationUrl, validateEnvVars } from '@/lib/google-oauth';

export async function GET(): Promise<NextResponse> {
  const envResult = validateEnvVars();

  if (!envResult.ok) {
    return NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 }
    );
  }

  const { clientId, baseUrl } = envResult.value;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri });

  return NextResponse.redirect(authUrl);
}
