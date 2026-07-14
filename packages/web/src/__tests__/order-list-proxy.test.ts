import { GET, POST } from '../app/api/order-list/[...path]/route';

const context = { params: Promise.resolve({ path: ['imports'] }) };
const originalApiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;
const originalApiBaseUrl = process.env.API_BASE_URL;
const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;
const originalFetch = global.fetch;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureAuth(): void {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  process.env.API_BASE_URL = 'https://api.internal.example';
}

function sameOriginHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Origin', 'http://localhost');
  headers.set('Sec-Fetch-Site', 'same-origin');
  return headers;
}

afterEach(() => {
  restoreEnv('ORDER_LIST_IMPORT_API_TOKEN', originalApiToken);
  restoreEnv('API_BASE_URL', originalApiBaseUrl);
  restoreEnv('NEXT_PUBLIC_API_URL', originalPublicApiUrl);
  global.fetch = originalFetch;
});

test('server secrets未設定時はproxyをfail closedする', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await GET(new Request('http://localhost/api/order-list/imports'), context);
  expect(response.status).toBe(503);
});

test('cross-originの書き込みはserver tokenを使う前に拒否する', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(new Request('http://localhost/api/order-list/imports', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    },
  }), context);

  expect(response.status).toBe(403);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

test('Originなしの書き込みはfail closedする', async () => {
  configureAuth();
  const response = await POST(new Request('http://localhost/api/order-list/imports', { method: 'POST' }), context);
  expect(response.status).toBe(403);
});

test('ブラウザ側の共有キーなしでserver Bearerとqueryを安全に転送する', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await GET(new Request('http://localhost/api/order-list/imports?limit=30'), context);

  expect(response.status).toBe(200);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  const [input, init] = upstreamFetch.mock.calls[0];
  expect(String(input)).toBe('https://api.internal.example/api/order-list/imports?limit=30');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${'a'.repeat(32)}`);
  expect(headers.has('x-order-list-operator-key')).toBe(false);
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
    headers: sameOriginHeaders({
      'Content-Type': 'application/octet-stream',
    }),
    body: requestBody,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const response = await POST(request, context);
  expect(request.headers.has('content-length')).toBe(false);

  expect(response.status).toBe(413);
  expect(upstreamFetch).toHaveBeenCalledTimes(1);
  expect(chunksSent).toBeGreaterThan(16);
});

test('Content-Lengthが16MB超ならupstreamへ接続せず拒否する', async () => {
  configureAuth();
  const upstreamFetch = jest.fn(async () => Response.json({ ok: true }));
  global.fetch = upstreamFetch as typeof fetch;

  const response = await POST(new Request('http://localhost/api/order-list/imports', {
    method: 'POST',
    headers: sameOriginHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(16 * 1024 * 1024 + 1),
    }),
  }), context);

  expect(response.status).toBe(413);
  expect(upstreamFetch).not.toHaveBeenCalled();
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
    allow_unresolved: true,
  };

  const response = await POST(new Request('http://localhost/api/order-list/imports/import-1/confirm', {
    method: 'POST',
    headers: sameOriginHeaders({ 'Content-Type': 'application/json' }),
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