import {
  OPERATOR_SESSION_COOKIE,
  operatorAuthRequiredFromEnv,
  operatorEmailAllowlistFromEnv,
  readCookie,
  verifyOperatorSession,
} from '@/lib/operator-auth';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

type RouteContext = { params: Promise<{ path: string[] }> };

function isSameOriginWrite(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const externalHost = forwardedHost || request.headers.get('host') || requestUrl.host;
  const externalProtocol = forwardedProto ? `${forwardedProto}:` : requestUrl.protocol;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(`${externalProtocol}//${externalHost}`).origin;
  } catch {
    return false;
  }
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin) return origin === requestOrigin && (!fetchSite || fetchSite === 'same-origin');
  if (fetchSite) return fetchSite === 'same-origin';
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === requestOrigin;
  } catch {
    return false;
  }
}

async function proxyCustomBuybackRequest(request: Request, context: RouteContext): Promise<Response> {
  if (!isSameOriginWrite(request)) {
    return Response.json({ error: '同一画面からの操作のみ受け付けます' }, { status: 403 });
  }
  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
  const apiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!apiToken || apiToken.length < 32) {
    return Response.json({ error: 'カスタム買取表APIの認証設定がありません' }, { status: 503 });
  }

  let operatorEmail: string | null = null;
  if (operatorAuthRequiredFromEnv()) {
    const session = readCookie(request.headers.get('cookie'), OPERATOR_SESSION_COOKIE);
    const sessionResult = await verifyOperatorSession({ session, secret: apiToken });
    if (!sessionResult.ok || !operatorEmailAllowlistFromEnv().has(sessionResult.value.email)) {
      return Response.json({ error: 'Operator authentication required' }, { status: 401 });
    }
    operatorEmail = sessionResult.value.email;
  }

  const { path } = await context.params;
  const upstreamUrl = new URL(`/api/custom-buyback/${path.map(encodeURIComponent).join('/')}`, apiBaseUrl);
  upstreamUrl.search = new URL(request.url).search;
  const headers = new Headers({
    Accept: request.headers.get('accept') ?? 'application/json',
    Authorization: `Bearer ${apiToken}`,
  });
  if (operatorEmail) headers.set('X-Haraka-Operator-Email', operatorEmail);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);

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
    const responseType = upstream.headers.get('content-type');
    if (responseType) responseHeaders.set('Content-Type', responseType);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return Response.json({
      error: 'カスタム買取表APIに接続できません',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}

export const GET = proxyCustomBuybackRequest;
export const POST = proxyCustomBuybackRequest;
export const PATCH = proxyCustomBuybackRequest;
export const PUT = proxyCustomBuybackRequest;
export const DELETE = proxyCustomBuybackRequest;
