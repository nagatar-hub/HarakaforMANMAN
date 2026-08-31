import { NextRequest } from 'next/server';
import { config, middleware } from '../middleware';
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
} from '@/lib/operator-auth';

const originalToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;
const originalOperatorEmails = process.env.ORDER_LIST_OPERATOR_EMAILS;
const originalAuthRequired = process.env.OPERATOR_AUTH_REQUIRED;
const secret = 'm'.repeat(32);

function restoreToken(): void {
  if (originalToken === undefined) delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  else process.env.ORDER_LIST_IMPORT_API_TOKEN = originalToken;
  if (originalOperatorEmails === undefined) delete process.env.ORDER_LIST_OPERATOR_EMAILS;
  else process.env.ORDER_LIST_OPERATOR_EMAILS = originalOperatorEmails;
  if (originalAuthRequired === undefined) delete process.env.OPERATOR_AUTH_REQUIRED;
  else process.env.OPERATOR_AUTH_REQUIRED = originalAuthRequired;
}

afterEach(restoreToken);

test('custom buyback pages require the same operator authentication as runs', () => {
  expect(config.matcher).toEqual(['/runs/:path*', '/custom-buyback/:path*', '/gallery/custom/:path*']);
});

test('/runs redirects an unauthenticated request to Google operator login', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = secret;
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  const response = await middleware(new NextRequest('https://app.example/runs?tab=imports'));

  expect(response.status).toBe(307);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin).toBe('https://app.example');
  expect(location.pathname).toBe('/api/auth/google');
  expect(location.searchParams.get('target')).toBe('operator');
  expect(location.searchParams.get('return_to')).toBe('/runs?tab=imports');
});
test('/runs allows unsigned requests when operator auth is disabled', async () => {
  process.env.OPERATOR_AUTH_REQUIRED = 'false';

  const response = await middleware(new NextRequest('https://app.example/runs?tab=imports'));

  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
});

test('/runs accepts a valid signed operator session', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = secret;
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  const session = await createOperatorSession({
    email: 'operator@example.com',
    secret,
  });
  const request = new NextRequest('https://app.example/runs', {
    headers: {
      Cookie: OPERATOR_SESSION_COOKIE + '=' + session,
    },
  });

  const response = await middleware(request);

  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-next')).toBe('1');
});

test('removing an operator from the allowlist revokes an existing session', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = secret;
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  const session = await createOperatorSession({
    email: 'operator@example.com',
    secret,
  });
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'other@example.com';
  const request = new NextRequest('https://app.example/runs', {
    headers: {
      Cookie: OPERATOR_SESSION_COOKIE + '=' + session,
    },
  });

  const response = await middleware(request);

  expect(response.status).toBe(307);
  expect(new URL(response.headers.get('location')!).pathname).toBe('/api/auth/google');
});
