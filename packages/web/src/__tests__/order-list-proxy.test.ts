import { GET, POST } from '../app/api/order-list/[...path]/route';
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
} from '@/lib/operator-auth';

const context = { params: Promise.resolve({ path: ['imports'] }) };
const originalApiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;
const originalApiBaseUrl = process.env.API_BASE_URL;
const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalOperatorEmails = process.env.ORDER_LIST_OPERATOR_EMAILS;
const originalFetch = global.fetch;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureAuth(): void {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  process.env.API_BASE_URL = 'https://api.internal.example';
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'operator@example.com';
}

async function authenticatedCookie(email = 'operator@example.com'): Promise<string> {
  const session = await createOperatorSession({
    email,
    secret: 'a'.repeat(32),
  });
  return OPERATOR_SESSION_COOKIE + '=' + session;
}

afterEach(() => {
  restoreEnv('ORDER_LIST_IMPORT_API_TOKEN', originalApiToken);
  restoreEnv('API_BASE_URL', originalApiBaseUrl);
  restoreEnv('NEXT_PUBLIC_API_URL', originalPublicApiUrl);
  restoreEnv('ORDER_LIST_OPERATOR_EMAILS', originalOperatorEmails);
  global.fetch = originalFetch;
});

test('server secrets未設定時はproxyをfail closedする', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await GET(new Request('http://localhost/api/order-list/imports'), context);
  expect(response.status).toBe(503);
});

test('unsigned proxy request returns 401 without upstream access', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await GET(new Request('http://localhost/api/order-list/imports'), context);

  expect(response.status).toBe(401);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

test('removing an operator from the allowlist immediately revokes the session', async () => {
  configureAuth();
  const cookie = await authenticatedCookie();
  process.env.ORDER_LIST_OPERATOR_EMAILS = 'other@example.com';

  const response = await GET(new Request('http://localhost/api/order-list/imports', {
    headers: { Cookie: cookie },
  }), context);

  expect(response.status).toBe(401);
});


test('ブラウザ側の共有キーなしでserver Bearerとqueryを安全に転送する', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await GET(new Request('http://localhost/api/order-list/imports?limit=30', {
    headers: { Cookie: await authenticatedCookie() },
  }), context);

  expect(response.status).toBe(200);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  const [input, init] = upstreamFetch.mock.calls[0];
  expect(String(input)).toBe('https://api.internal.example/api/order-list/imports?limit=30');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${'a'.repeat(32)}`);
  expect(headers.has('x-order-list-operator-key')).toBe(false);
});
test('strips a leading BOM from API_BASE_URL before building the upstream URL', async () => {
  configureAuth();
  process.env.API_BASE_URL = '\uFEFFhttps://api.internal.example';
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL) => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await GET(new Request('http://localhost/api/order-list/imports', {
    headers: { Cookie: await authenticatedCookie() },
  }), context);

  expect(response.status).toBe(200);
  expect(String(upstreamFetch.mock.calls[0][0])).toBe(
    'https://api.internal.example/api/order-list/imports',
  );
});


test('Content-Lengthなしのchunked bodyも16MB超過時にstreamingで拒否する', async () => {
  configureAuth();
  const chunkSize = 1024 * 1024;
  let chunksSent = 0;
  const requestBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunksSent >= 17) {
        controller.close();
        return;
      }
      chunksSent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return Response.json({ ok: true });
  });
  global.fetch = upstreamFetch as typeof fetch;

  const request = new Request('http://localhost/api/order-list/imports', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Origin: 'http://localhost',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: await authenticatedCookie(),
    },
    body: requestBody,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const response = await POST(request, context);
  expect(request.headers.has('content-length')).toBe(false);

  expect(response.status).toBe(413);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  expect(chunksSent).toBeGreaterThan(16);
});


test('confirmの一括対応付けJSONをBearer付きでそのまま転送する', async () => {
  configureAuth();
  let forwardedBody = '';
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwardedBody = await new Response(init?.body).text();
    return Response.json({ import_id: 'import-1', status: 'confirmed', sync_started: true });
  });
  global.fetch = upstreamFetch as typeof fetch;
  const payload = {
    mappings: [{ item_id: 'item-1', db_card_id: 'card-1' }],
    new_cards: [{
      item_id: 'item-2', card_name: '新商品', grade: 'PSA10', list_no: '001', tag: 'TOP', alt_image_url: null,
    }],
    allow_unresolved: true,
  };

  const response = await POST(new Request('http://localhost/api/order-list/imports/import-1/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: await authenticatedCookie(),
    },
    body: JSON.stringify(payload),
  }), { params: Promise.resolve({ path: ['imports', 'import-1', 'confirm'] }) });

  expect(response.status).toBe(200);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  const [input, init] = upstreamFetch.mock.calls[0];
  expect(String(input)).toBe('https://api.internal.example/api/order-list/imports/import-1/confirm');
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'a'.repeat(32)}`);
  expect(JSON.parse(forwardedBody)).toEqual(payload);
});

test('別オリジンからの書込要求はupstreamへ送らず拒否する', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(new Request('http://localhost/api/order-list/imports/import-1/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    },
    body: '{}',
  }), { params: Promise.resolve({ path: ['imports', 'import-1', 'confirm'] }) });

  expect(response.status).toBe(403);
  expect(upstreamFetch).not.toHaveBeenCalled();
});
