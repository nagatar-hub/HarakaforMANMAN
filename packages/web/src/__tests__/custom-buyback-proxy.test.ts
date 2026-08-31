import { GET, PATCH, POST } from '../app/api/custom-buyback/[...path]/route';
import { OPERATOR_SESSION_COOKIE, createOperatorSession } from '@/lib/operator-auth';

const original = {
  token: process.env.ORDER_LIST_IMPORT_API_TOKEN,
  base: process.env.API_BASE_URL,
  emails: process.env.ORDER_LIST_OPERATOR_EMAILS,
  required: process.env.OPERATOR_AUTH_REQUIRED,
  fetch: global.fetch,
};
const context = { params: Promise.resolve({ path: ['sheets'] }) };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

afterEach(() => {
  restore('ORDER_LIST_IMPORT_API_TOKEN', original.token);
  restore('API_BASE_URL', original.base);
  restore('ORDER_LIST_OPERATOR_EMAILS', original.emails);
  restore('OPERATOR_AUTH_REQUIRED', original.required);
  global.fetch = original.fetch;
});

async function configure() {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'z'.repeat(32);
  process.env.API_BASE_URL = 'https://internal.example';
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
  process.env.OPERATOR_AUTH_REQUIRED = 'true';
  const session = await createOperatorSession({ email: 'operator@example.com', secret: 'z'.repeat(32) });
  return `${OPERATOR_SESSION_COOKIE}=${session}`;
}

test('custom buyback proxy fails closed without the server token', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  expect((await GET(new Request('http://localhost/api/custom-buyback/sheets'), context)).status).toBe(503);
});

test('custom buyback proxy forwards only the server token and verified operator identity', async () => {
  const cookie = await configure();
  const upstream = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await GET(new Request('http://localhost/api/custom-buyback/sheets?limit=10', { headers: { Cookie: cookie } }), context);
  expect(response.status).toBe(200);
  const [url, init] = upstream.mock.calls[0];
  expect(String(url)).toBe('https://internal.example/api/custom-buyback/sheets?limit=10');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${'z'.repeat(32)}`);
  expect(headers.get('x-haraka-operator-email')).toBe('operator@example.com');
});

test('custom buyback proxy rejects cross-origin writes', async () => {
  await configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await POST(new Request('http://localhost/api/custom-buyback/sheets', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' }, body: '{}',
  }), context);
  expect(response.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

test('custom buyback proxy accepts a same-origin Referer when browser fetch metadata is absent', async () => {
  const cookie = await configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await PATCH(new Request('http://localhost/api/custom-buyback/sheets/a', {
    method: 'PATCH',
    headers: { Referer: 'http://localhost/custom-buyback?sheet=a', Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{"display_date":"2026-08-07"}',
  }), { params: Promise.resolve({ path: ['sheets', 'a'] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

test('custom buyback proxy compares Referer with the forwarded public origin', async () => {
  const cookie = await configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await PATCH(new Request('http://localhost:3102/api/custom-buyback/sheets/a', {
    method: 'PATCH',
    headers: {
      Referer: 'https://buyback.example/custom-buyback?sheet=a',
      'X-Forwarded-Host': 'buyback.example',
      'X-Forwarded-Proto': 'https',
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: '{"display_date":"2026-08-07"}',
  }), { params: Promise.resolve({ path: ['sheets', 'a'] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

test('custom buyback proxy rejects bodies over 2MB before upstream access', async () => {
  const cookie = await configure();
  const upstream = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstream as typeof fetch;
  const response = await POST(new Request('http://localhost/api/custom-buyback/sheets', {
    method: 'POST',
    headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie },
    body: 'x'.repeat(2 * 1024 * 1024 + 1),
  }), context);
  expect(response.status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
