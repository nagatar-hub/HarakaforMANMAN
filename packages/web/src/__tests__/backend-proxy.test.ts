import { GET, POST } from '../app/api/backend/[...path]/route';
import { OPERATOR_SESSION_COOKIE, createOperatorSession } from '@/lib/operator-auth';

const original = {
  token: process.env.ORDER_LIST_IMPORT_API_TOKEN,
  apiBase: process.env.API_BASE_URL,
  emails: process.env.ORDER_LIST_OPERATOR_EMAILS,
  authRequired: process.env.OPERATOR_AUTH_REQUIRED,
  store: process.env.STORE_NAME,
};
const originalFetch = global.fetch;
const context = { params: Promise.resolve({ path: ['api', 'rules'] }) };
const token = 'b'.repeat(32);

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function operatorCookie(): Promise<string> {
  const session = await createOperatorSession({ email: 'operator@example.com', secret: token });
  return `${OPERATOR_SESSION_COOKIE}=${session}`;
}

function configure(): void {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = token;
  process.env.API_BASE_URL = 'https://internal.example';
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  process.env.OPERATOR_AUTH_REQUIRED = 'true';
}

afterEach(() => {
  restore('ORDER_LIST_IMPORT_API_TOKEN', original.token);
  restore('API_BASE_URL', original.apiBase);
  restore('ORDER_LIST_OPERATOR_EMAILS', original.emails);
  restore('OPERATOR_AUTH_REQUIRED', original.authRequired);
  restore('STORE_NAME', original.store);
  global.fetch = originalFetch;
});

test('backend proxy forwards an authenticated mutation with server credentials and actor only', async () => {
  configure();
  const upstream = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
    Response.json({ ok: true }, { status: 201 })
  ));
  global.fetch = upstream as typeof fetch;
  const response = await POST(new Request('https://app.example/api/backend/api/rules?ignored=read-filter', {
    method: 'POST',
    headers: {
      Origin: 'https://app.example',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: await operatorCookie(),
      'Content-Type': 'application/json',
      Authorization: 'Bearer browser-controlled',
    },
    body: JSON.stringify({ tag_pattern: 'PSA10' }),
  }), context);

  expect(response.status).toBe(201);
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, init] = upstream.mock.calls[0];
  expect(String(url)).toBe('https://internal.example/api/rules?ignored=read-filter');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${token}`);
  expect(headers.get('x-haraka-operator-email')).toBe('operator@example.com');
  expect(headers.has('cookie')).toBe(false);
});

test('backend proxy rejects cross-origin writes before upstream access', async () => {
  configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await POST(new Request('https://app.example/api/backend/api/rules', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
      Cookie: await operatorCookie(),
    },
    body: '{}',
  }), context);

  expect(response.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

test('Tokyo proxy cannot send an actorless mutation even when the legacy auth opt-out is false', async () => {
  configure();
  process.env.STORE_NAME = 'manman-akihabara';
  process.env.OPERATOR_AUTH_REQUIRED = 'false';
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;

  const response = await POST(new Request('https://app.example/api/backend/api/rules', {
    method: 'POST',
    headers: { Origin: 'https://app.example', 'Sec-Fetch-Site': 'same-origin' },
    body: '{}',
  }), context);

  expect(response.status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

test('backend proxy rejects unsigned reads and oversized writes before upstream access', async () => {
  configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const read = await GET(new Request('https://app.example/api/backend/api/rules'), context);
  expect(read.status).toBe(401);
  const write = await POST(new Request('https://app.example/api/backend/api/rules', {
    method: 'POST',
    headers: {
      Origin: 'https://app.example',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: await operatorCookie(),
    },
    body: 'x'.repeat(2 * 1024 * 1024 + 1),
  }), context);
  expect(write.status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
