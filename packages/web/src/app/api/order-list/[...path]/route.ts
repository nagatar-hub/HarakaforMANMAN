const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function isSameOriginWrite(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return origin === new URL(request.url).origin
    && (!fetchSite || fetchSite === 'same-origin');
}

async function proxyOrderListRequest(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOriginWrite(request)) {
    return Response.json({ error: '同一画面からの操作のみ受け付けます' }, { status: 403 });
  }

  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
  const apiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();

  if (!apiToken || apiToken.length < 32) {
    return Response.json({ error: 'オーダーリスト取込の認証設定がありません' }, { status: 503 });
  }

  const { path } = await context.params;
  const upstreamUrl = new URL(
    `/api/order-list/${path.map(encodeURIComponent).join('/')}`,
    apiBaseUrl,
  );
  upstreamUrl.search = new URL(request.url).search;

  const headers = new Headers({
    Accept: request.headers.get('accept') ?? 'application/json',
    Authorization: `Bearer ${apiToken}`,
  });
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);

  let body: ReadableStream<Uint8Array> | undefined;
  let receivedBytes = 0;
  let requestTooLarge = false;
  const sizeAbort = new AbortController();
  const upstreamSignal = AbortSignal.any([request.signal, sizeAbort.signal]);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: 'リクエストサイズは16MB以下にしてください' }, { status: 413 });
    }
    if (request.body) {
      body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > MAX_REQUEST_BYTES) {
            requestTooLarge = true;
            controller.error(new Error('ORDER_LIST_REQUEST_TOO_LARGE'));
            sizeAbort.abort();
            return;
          }
          controller.enqueue(chunk);
        },
      }));
    }
  }

  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      signal: upstreamSignal,
    };
    if (body) init.duplex = 'half';
    upstream = await fetch(upstreamUrl, init);
  } catch (error) {
    if (requestTooLarge) {
      return Response.json({ error: 'リクエストサイズは16MB以下にしてください' }, { status: 413 });
    }
    return Response.json({
      error: 'オーダーリストAPIに接続できません',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }

  const responseHeaders = new Headers();
  const responseType = upstream.headers.get('content-type');
  if (responseType) responseHeaders.set('Content-Type', responseType);
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) responseHeaders.set('Content-Disposition', disposition);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxyOrderListRequest;
export const POST = proxyOrderListRequest;
export const PATCH = proxyOrderListRequest;
