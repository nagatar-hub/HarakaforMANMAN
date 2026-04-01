/**
 * GET /api/auth/google/callback
 *
 * Google OAuth コールバックエンドポイント。
 * Google から受け取った認可コードを使ってトークンを取得し、
 * Phase 0 では取得した tokens を JSON で返す（画面表示確認用）。
 *
 * Phase 1 以降: refresh_token を Secret Manager に保存する処理を追加予定。
 *
 * クエリパラメータ:
 *   code  — Google が発行した認可コード
 *   error — 認可が拒否された場合のエラーコード（例: access_denied）
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForTokens,
  extractRefreshToken,
  validateEnvVars,
} from '@/lib/google-oauth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  // --- ユーザーが認可を拒否した場合 ---
  const oauthError = searchParams.get('error');
  if (oauthError) {
    return NextResponse.json(
      { error: 'OAuth authorization denied', detail: oauthError },
      { status: 400 }
    );
  }

  // --- 認可コードの取得 ---
  const code = searchParams.get('code');
  if (!code) {
    return NextResponse.json(
      { error: 'Missing authorization code' },
      { status: 400 }
    );
  }

  // --- 環境変数の検証 ---
  const envResult = validateEnvVars();
  if (!envResult.ok) {
    return NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 }
    );
  }

  const { clientId, clientSecret, baseUrl } = envResult.value;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  // --- 認可コードをトークンと交換 ---
  const tokenResult = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
    redirectUri,
  });

  if (!tokenResult.ok) {
    return NextResponse.json(
      { error: 'Token exchange failed', detail: tokenResult.error },
      { status: 502 }
    );
  }

  const tokens = tokenResult.value;
  const refreshToken = extractRefreshToken(tokens);

  // --- Phase 0: 取得したトークン情報を JSON で返す ---
  // Phase 1 以降で Secret Manager への保存処理を追加する
  return NextResponse.json({
    message: 'OAuth tokens retrieved successfully',
    note: 'Phase 0: tokens displayed for verification. Phase 1 will store refresh_token in Secret Manager.',
    tokens: {
      access_token: tokens.access_token,
      refresh_token: refreshToken,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      has_refresh_token: refreshToken !== null,
    },
  });
}
