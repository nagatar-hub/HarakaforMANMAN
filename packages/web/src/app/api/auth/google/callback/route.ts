/**
 * Completes signed Google OAuth flows. Operator login is public, while sheet
 * credential rotation requires the same current operator session at both the
 * start and callback boundaries.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForTokens,
  extractRefreshToken,
  validateEnvVars,
} from '@/lib/google-oauth';
import {
  OPERATOR_OAUTH_NONCE_COOKIE,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_TTL_SECONDS,
  createOperatorSession,
  fetchGoogleOperatorUser,
  isOperatorState,
  operatorAuthSecretFromEnv,
  operatorEmailAllowlistFromEnv,
  verifyOperatorSession,
  verifyOperatorState,
} from '@/lib/operator-auth';

const OPERATOR_NONCE_PATH = '/api/auth/google/callback';

function secureCookie(): boolean {
  return process.env.NODE_ENV === 'production';
}

function clearOperatorNonce(response: NextResponse): NextResponse {
  response.cookies.set(OPERATOR_OAUTH_NONCE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: OPERATOR_NONCE_PATH,
    maxAge: 0,
  });
  return response;
}

async function hasCurrentOperatorSession(
  request: NextRequest,
  secret: string,
): Promise<boolean> {
  const session = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  const verified = await verifyOperatorSession({ session, secret });
  return verified.ok && operatorEmailAllowlistFromEnv().has(verified.value.email);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const callbackState = request.nextUrl.searchParams.get('state');
  if (!callbackState || !isOperatorState(callbackState)) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'A signed OAuth state is required' },
      { status: 400 },
    ));
  }

  const secretResult = operatorAuthSecretFromEnv();
  if (!secretResult.ok || operatorEmailAllowlistFromEnv().size === 0) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'Operator authentication is not configured' },
      { status: 503 },
    ));
  }
  const stateResult = await verifyOperatorState({
    state: callbackState,
    nonceCookie: request.cookies.get(OPERATOR_OAUTH_NONCE_COOKIE)?.value,
    secret: secretResult.value,
  });
  if (!stateResult.ok) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'Invalid OAuth state', detail: stateResult.error },
      { status: 400 },
    ));
  }

  const target = stateResult.value.target;
  if (target !== 'operator'
    && !await hasCurrentOperatorSession(request, secretResult.value)) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'Current operator authentication is required' },
      { status: 401 },
    ));
  }

  const oauthError = request.nextUrl.searchParams.get('error');
  if (oauthError) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'OAuth authorization denied', detail: oauthError },
      { status: 400 },
    ));
  }
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'Missing authorization code' },
      { status: 400 },
    ));
  }

  const envResult = validateEnvVars(request.headers);
  if (!envResult.ok) {
    return clearOperatorNonce(NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 },
    ));
  }
  const { clientId, clientSecret, baseUrl } = envResult.value;
  const tokenResult = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
    redirectUri: baseUrl + '/api/auth/google/callback',
  });
  if (!tokenResult.ok || !tokenResult.value.access_token) {
    return clearOperatorNonce(NextResponse.json(
      {
        error: 'Token exchange failed',
        detail: tokenResult.ok ? 'Missing access token' : tokenResult.error,
      },
      { status: 502 },
    ));
  }

  if (target === 'operator') {
    const userResult = await fetchGoogleOperatorUser(tokenResult.value.access_token);
    if (!userResult.ok) {
      return clearOperatorNonce(NextResponse.json(
        { error: 'Operator access denied', detail: userResult.error },
        { status: 403 },
      ));
    }
    const session = await createOperatorSession({
      email: userResult.value.email,
      secret: secretResult.value,
    });
    const response = NextResponse.redirect(
      new URL(stateResult.value.returnTo, request.url),
    );
    response.cookies.set(OPERATOR_SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie(),
      path: '/',
      maxAge: OPERATOR_SESSION_TTL_SECONDS,
    });
    return clearOperatorNonce(response);
  }

  const refreshToken = extractRefreshToken(tokenResult.value);
  const isKecak = target === 'kecak';
  return clearOperatorNonce(NextResponse.json({
    message: (isKecak ? 'KECAK sheet' : 'Haraka DB sheet')
      + ' OAuth tokens retrieved successfully',
    note: 'Tokens are returned for the existing credential setup flow and are not persisted by the web app.',
    target,
    tokens: {
      access_token: tokenResult.value.access_token,
      refresh_token: refreshToken,
      token_type: tokenResult.value.token_type,
      expires_in: tokenResult.value.expires_in,
      scope: tokenResult.value.scope,
      has_refresh_token: refreshToken !== null,
    },
  }));
}