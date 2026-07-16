import { POST } from '../app/api/run-actions/generate/route';
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
} from '@/lib/operator-auth';

const originalApiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;
const originalApiBaseUrl = process.env.API_BASE_URL;
const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalOperatorEmails = process.env.ORDER_LIST_OPERATOR_EMAILS;
const originalAuthRequired = process.env.OPERATOR_AUTH_REQUIRED;
const originalFetch = global.fetch;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureAuth(): void {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  process.env.API_BASE_URL = 'https://api.internal.example';
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  process.env.OPERATOR_AUTH_REQUIRED = 'true';
}

async function authenticatedCookie(): Promise<string> {
  const session = await createOperatorSession({
    email: 'operator@example.com',
    secret: 'a'.repeat(32),
  });
  return `${OPERATOR_SESSION_COOKIE}=${session}`;
}

async function generateRequest(options: {
  origin?: string;
  cookie?: string;
  body?: string;
  authorization?: string;
} = {}): Promise<Request> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: options.origin ?? 'https://app.example',
    'Sec-Fetch-Site': options.origin === 'https://attacker.example' ? 'cross-site' : 'same-origin',
  });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.authorization) headers.set('Authorization', options.authorization);
  return new Request('https://app.example/api/run-actions/generate', {
    method: 'POST',
    headers,
    body: options.body ?? JSON.stringify({ run_id: 'run-1' }),
  });
}

afterEach(() => {
  restoreEnv('ORDER_LIST_IMPORT_API_TOKEN', originalApiToken);
  restoreEnv('API_BASE_URL', originalApiBaseUrl);
  restoreEnv('NEXT_PUBLIC_API_URL', originalPublicApiUrl);
  restoreEnv('ORDER_LIST_OPERATOR_EMAILS', originalOperatorEmails);
  restoreEnv('OPERATOR_AUTH_REQUIRED', originalAuthRequired);
  global.fetch = originalFetch;
});

test('fails closed when the server API token is missing', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await POST(await generateRequest());
  expect(response.status).toBe(503);
});

test('requires a valid current operator session without upstream access', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest());

  expect(response.status).toBe(401);
  expect(upstreamFetch).not.toHaveBeenCalled();
});
test('public mode forwards unsigned generation requests with the server token', async () => {
  configureAuth();
  process.env.OPERATOR_AUTH_REQUIRED = 'false';
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL) => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest());

  expect(response.status).toBe(200);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
});


test('revokes an existing session when its email is removed from the allowlist', async () => {
  configureAuth();
  const cookie = await authenticatedCookie();
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'other@example.com';
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest({ cookie }));

  expect(response.status).toBe(401);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

test('rejects cross-origin writes without upstream access', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest({
    origin: 'https://attacker.example',
    cookie: await authenticatedCookie(),
  }));

  expect(response.status).toBe(403);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

test('forwards only the selected run ID with a server-side Bearer token', async () => {
  configureAuth();
  let forwardedBody = '';
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwardedBody = String(init?.body ?? '');
    return Response.json({ status: 'triggered', run_id: 'run-1' });
  });
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest({
    cookie: await authenticatedCookie(),
    authorization: 'Bearer client-controlled',
    body: JSON.stringify({ run_id: ' run-1 ', ignored: 'value' }),
  }));

  expect(response.status).toBe(200);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  const [input, init] = upstreamFetch.mock.calls[0];
  expect(String(input)).toBe('https://api.internal.example/api/jobs/generate');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'a'.repeat(32)}`);
  expect(JSON.parse(forwardedBody)).toEqual({ run_id: 'run-1' });
});

test('strips a leading BOM from API_BASE_URL before calling the generate API', async () => {
  configureAuth();
  process.env.API_BASE_URL = '\uFEFFhttps://api.internal.example';
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL) => Response.json({ status: 'triggered' }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(await generateRequest({ cookie: await authenticatedCookie() }));

  expect(response.status).toBe(200);
  expect(String(upstreamFetch.mock.calls[0][0])).toBe(
    'https://api.internal.example/api/jobs/generate',
  );
});

test('preserves an upstream non-2xx response for the UI', async () => {
  configureAuth();
  global.fetch = jest.fn(async () => Response.json(
    { error: 'このRunは画像生成済みです' },
    { status: 409 },
  )) as typeof fetch;

  const response = await POST(await generateRequest({ cookie: await authenticatedCookie() }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: 'このRunは画像生成済みです' });
});
