import {
  OPERATOR_SESSION_COOKIE,
  isOperatorEmailAllowed,
  operatorAuthRequiredFromEnv,
  readCookie,
  verifyOperatorSession,
} from '@/lib/operator-auth';
import { serverApiBaseUrl } from '@/lib/server-api-url';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
type RouteContext = { params: Promise<{ path: string[] }> };

function isSameOriginWrite(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return origin === new URL(request.url).origin
    && (!fetchSite || fetchSite === 'same-origin');
}

async function proxyBackendRequest(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOriginWrite(request)) {
    return Response.json({ error: '同一画面からの操作のみ受け付けます' }, { status: 403 });
  }
  const apiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!apiToken || apiToken.length < 32) {
    return Response.json({ error: 'APIの認証設定がありません' }, { status: 503 });
  }

  let operatorEmail: string | null = null;
  if (operatorAuthRequiredFromEnv()) {
    const session = readCookie(request.headers.get('cookie'), OPERATOR_SESSION_COOKIE);
    const sessionResult = await verifyOperatorSession({ session, secret: apiToken });
    if (!sessionResult.ok || !isOperatorEmailAllowed(sessionResult.value.email)) {
      return Response.json({ error: 'Operator authentication required' }, { status: 401 });
    }
    operatorEmail = sessionResult.value.email;
  }

  const { path } = await context.params;
  const upstreamUrl = new URL(`/${path.map(encodeURIComponent).join('/')}`, serverApiBaseUrl());
  upstreamUrl.search = new URL(request.url).search;
  const headers = new Headers({
    Accept: request.headers.get('accept') ?? 'application/json',
    Authorization: `Bearer ${apiToken}`,
  });
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  if (operatorEmail) headers.set('X-Haraka-Operator-Email', operatorEmail);

  let body: ArrayBuffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: 'リクエストサイズは2MB以下にしてください' }, { status: 413 });
    }
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: 'リクエストサイズは2MB以下にしてください' }, { status: 413 });
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      signal: request.signal,
    });
    const responseHeaders = new Headers();
    for (const name of ['content-type', 'content-disposition', 'location']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return Response.json({
      error: 'APIに接続できません',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}

export const GET = proxyBackendRequest;
export const POST = proxyBackendRequest;
export const PUT = proxyBackendRequest;
export const PATCH = proxyBackendRequest;
export const DELETE = proxyBackendRequest;
