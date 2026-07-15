/**
 * Starts Google OAuth for either public operator login or protected sheet
 * credential rotation. Sheet and KECAK flows require a current operator
 * session and always use a signed short-lived state plus nonce.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizationUrl, validateEnvVars } from '@/lib/google-oauth';
import {
  OPERATOR_OAUTH_NONCE_COOKIE,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_STATE_TTL_SECONDS,
  createOperatorNonce,
  createOperatorState,
  operatorAuthSecretFromEnv,
  operatorEmailAllowlistFromEnv,
  safeRelativeReturnTo,
  verifyOperatorSession,
  type OperatorOAuthTarget,
} from '@/lib/operator-auth';

const OPERATOR_NONCE_PATH = '/api/auth/google/callback';

function secureCookie(): boolean {
  return process.env.NODE_ENV === 'production';
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
  const envResult = validateEnvVars(request.headers);
  if (!envResult.ok) {
    return NextResponse.json(
      { error: 'Configuration error', detail: envResult.error },
      { status: 500 },
    );
  }

  const requestedTarget = request.nextUrl.searchParams.get('target');
  if (requestedTarget !== null
    && requestedTarget !== 'operator'
    && requestedTarget !== 'kecak') {
    return NextResponse.json({ error: 'Unknown Google OAuth target' }, { status: 400 });
  }
  const target: OperatorOAuthTarget = requestedTarget === 'operator'
    ? 'operator'
    : requestedTarget === 'kecak' ? 'kecak' : 'sheet';

  const secretResult = operatorAuthSecretFromEnv();
  if (!secretResult.ok || operatorEmailAllowlistFromEnv().size === 0) {
    return NextResponse.json(
      { error: 'Operator authentication is not configured' },
      { status: 503 },
    );
  }
  if (target !== 'operator'
    && !await hasCurrentOperatorSession(request, secretResult.value)) {
    return NextResponse.json(
      { error: 'Current operator authentication is required' },
      { status: 401 },
    );
  }

  const { clientId, baseUrl } = envResult.value;
  const redirectUri = baseUrl + '/api/auth/google/callback';
  const nonce = createOperatorNonce();
  const state = await createOperatorState({
    nonce,
    returnTo: target === 'operator'
      ? safeRelativeReturnTo(request.nextUrl.searchParams.get('return_to'))
      : '/runs',
    target,
    secret: secretResult.value,
  });
  const authUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    mode: target === 'operator' ? 'operator' : 'sheet',
  });
  const response = NextResponse.redirect(authUrl);
  response.cookies.set(OPERATOR_OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: OPERATOR_NONCE_PATH,
    maxAge: OPERATOR_STATE_TTL_SECONDS,
  });
  return response;
}
