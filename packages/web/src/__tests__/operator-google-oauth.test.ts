import { NextRequest } from 'next/server';
import { GET as startGoogleOAuth } from '../app/api/auth/google/route';
import { GET as completeGoogleOAuth } from '../app/api/auth/google/callback/route';
import {
  OPERATOR_OAUTH_NONCE_COOKIE,
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
  createOperatorState,
  verifyOperatorSession,
  verifyOperatorState,
  type OperatorOAuthTarget,
} from '@/lib/operator-auth';
const secret = 'o'.repeat(32);
const originalFetch = global.fetch;
const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  ORDER_LIST_IMPORT_API_TOKEN: process.env.ORDER_LIST_IMPORT_API_TOKEN,
  ORDER_LIST_OPERATOR_EMAILS: process.env.ORDER_LIST_OPERATOR_EMAILS,
};

function configureOperatorOAuth(): void {
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  process.env.NEXTAUTH_URL = 'https://app.example';
  process.env.ORDER_LIST_IMPORT_API_TOKEN = secret;
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com, second@example.com';
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function operatorCookie(): Promise<string> {
  const session = await createOperatorSession({
    email: 'operator@example.com',
    secret,
  });
  return OPERATOR_SESSION_COOKIE + '=' + session;
}

function callbackRequest(
  state: string,
  nonce: string,
  sessionCookie?: string,
): NextRequest {
  const url = new URL('https://app.example/api/auth/google/callback');
  url.searchParams.set('code', 'authorization-code');
  url.searchParams.set('state', state);
  const cookies = [OPERATOR_OAUTH_NONCE_COOKIE + '=' + nonce];
  if (sessionCookie) cookies.push(sessionCookie);
  return new NextRequest(url, {
    headers: {
      Cookie: cookies.join('; '),
      Host: 'app.example',
      'X-Forwarded-Proto': 'https',
    },
  });
}

afterEach(() => {
  (Object.keys(originalEnv) as Array<keyof typeof originalEnv>).forEach(restoreEnv);
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('operator start remains public and requests only openid email', async () => {
  configureOperatorOAuth();
  const request = new NextRequest(
    'https://app.example/api/auth/google?target=operator&return_to=%2Fruns%3Ftab%3Dimports',
    { headers: { Host: 'app.example', 'X-Forwarded-Proto': 'https' } },
  );

  const response = await startGoogleOAuth(request);

  expect(response.status).toBe(307);
  const authorizationUrl = new URL(response.headers.get('location')!);
  expect(authorizationUrl.origin).toBe('https://accounts.google.com');
  expect(authorizationUrl.searchParams.get('scope')?.split(' ').sort())
    .toEqual(['email', 'openid']);
  expect(authorizationUrl.searchParams.has('access_type')).toBe(false);
  expect(authorizationUrl.searchParams.get('prompt')).toBe('select_account');

  const nonce = response.cookies.get(OPERATOR_OAUTH_NONCE_COOKIE)?.value;
  const state = authorizationUrl.searchParams.get('state');
  await expect(verifyOperatorState({
    state: state!,
    nonceCookie: nonce,
    secret,
  })).resolves.toMatchObject({
    ok: true,
    value: { target: 'operator', returnTo: '/runs?tab=imports' },
  });
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('Path=/api/auth/google/callback');
});

test('operator callback issues a session to a verified allowlisted user', async () => {
  configureOperatorOAuth();
  const nonce = 'nonce-success';
  const state = await createOperatorState({
    nonce,
    returnTo: '/runs',
    target: 'operator',
    secret,
  });
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(Response.json({
      access_token: 'access-token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid email',
    }))
    .mockResolvedValueOnce(Response.json({
      email: 'Operator@Example.COM',
      email_verified: true,
    }));
  global.fetch = fetchMock as typeof fetch;

  const response = await completeGoogleOAuth(callbackRequest(state, nonce));

  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('https://app.example/runs');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const session = response.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  await expect(verifyOperatorSession({ session, secret })).resolves.toMatchObject({
    ok: true,
    value: { email: 'operator@example.com' },
  });
});

test('operator callback fails closed for an unverified user', async () => {
  configureOperatorOAuth();
  const nonce = 'nonce-unverified';
  const state = await createOperatorState({ nonce, returnTo: '/runs', secret });
  global.fetch = jest.fn()
    .mockResolvedValueOnce(Response.json({
      access_token: 'access-token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid email',
    }))
    .mockResolvedValueOnce(Response.json({
      email: 'operator@example.com',
      email_verified: false,
    })) as typeof fetch;

  const response = await completeGoogleOAuth(callbackRequest(state, nonce));

  expect(response.status).toBe(403);
  expect(response.cookies.get(OPERATOR_SESSION_COOKIE)).toBeUndefined();
});

test('operator callback rejects tampered state before token exchange', async () => {
  configureOperatorOAuth();
  const nonce = 'nonce-tamper';
  const validState = await createOperatorState({ nonce, returnTo: '/runs', secret });
  const stateParts = validState.split('.');
  stateParts[2] = (stateParts[2].startsWith('A') ? 'B' : 'A') + stateParts[2].slice(1);
  const state = stateParts.join('.');
  const fetchMock = jest.fn();
  global.fetch = fetchMock as typeof fetch;

  const response = await completeGoogleOAuth(callbackRequest(state, nonce));

  expect(response.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('sheet OAuth start rejects an unauthenticated request', async () => {
  configureOperatorOAuth();

  const response = await startGoogleOAuth(new NextRequest(
    'https://app.example/api/auth/google',
    { headers: { Host: 'app.example', 'X-Forwarded-Proto': 'https' } },
  ));

  expect(response.status).toBe(401);
  expect(response.headers.get('location')).toBeNull();
});

test.each([
  { query: '', expectedTarget: 'sheet' as OperatorOAuthTarget },
  { query: '?target=kecak', expectedTarget: 'kecak' as OperatorOAuthTarget },
])('authorized $expectedTarget start uses signed sheet OAuth state', async ({
  query,
  expectedTarget,
}) => {
  configureOperatorOAuth();
  const response = await startGoogleOAuth(new NextRequest(
    'https://app.example/api/auth/google' + query,
    {
      headers: {
        Cookie: await operatorCookie(),
        Host: 'app.example',
        'X-Forwarded-Proto': 'https',
      },
    },
  ));

  expect(response.status).toBe(307);
  const authorizationUrl = new URL(response.headers.get('location')!);
  const scope = authorizationUrl.searchParams.get('scope') ?? '';
  expect(scope).toContain('https://www.googleapis.com/auth/spreadsheets');
  expect(scope).toContain('https://www.googleapis.com/auth/drive.readonly');
  expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
  expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');

  const nonce = response.cookies.get(OPERATOR_OAUTH_NONCE_COOKIE)?.value;
  await expect(verifyOperatorState({
    state: authorizationUrl.searchParams.get('state')!,
    nonceCookie: nonce,
    secret,
  })).resolves.toMatchObject({
    ok: true,
    value: { target: expectedTarget },
  });
});

test('sheet callback revalidates the current operator session before exchange', async () => {
  configureOperatorOAuth();
  const nonce = 'sheet-no-session';
  const state = await createOperatorState({
    nonce,
    returnTo: '/runs',
    target: 'sheet',
    secret,
  });
  const fetchMock = jest.fn();
  global.fetch = fetchMock as typeof fetch;

  const response = await completeGoogleOAuth(callbackRequest(state, nonce));

  expect(response.status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  { target: 'sheet' as OperatorOAuthTarget },
  { target: 'kecak' as OperatorOAuthTarget },
])('authorized $target callback returns tokens only after operator revalidation', async ({ target }) => {
  configureOperatorOAuth();
  const nonce = 'sheet-authorized-' + target;
  const state = await createOperatorState({
    nonce,
    returnTo: '/runs',
    target,
    secret,
  });
  const fetchMock = jest.fn().mockResolvedValueOnce(Response.json({
    access_token: 'sheet-access-token',
    refresh_token: 'sheet-refresh-token',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
  }));
  global.fetch = fetchMock as typeof fetch;

  const response = await completeGoogleOAuth(callbackRequest(
    state,
    nonce,
    await operatorCookie(),
  ));

  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await response.json()).toMatchObject({
    target,
    tokens: {
      access_token: 'sheet-access-token',
      refresh_token: 'sheet-refresh-token',
      has_refresh_token: true,
    },
  });
});
test('legacy unsigned sheet callback is rejected before exchange', async () => {
  configureOperatorOAuth();
  const fetchMock = jest.fn();
  global.fetch = fetchMock as typeof fetch;

  const response = await completeGoogleOAuth(new NextRequest(
    'https://app.example/api/auth/google/callback?code=authorization-code&state=kecak',
    { headers: { Cookie: await operatorCookie() } },
  ));

  expect(response.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});
