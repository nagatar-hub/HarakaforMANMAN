import {
  OPERATOR_SESSION_COOKIE,
  isOperatorEmailAllowed,
  operatorAuthRequiredFromEnv,
  readCookie,
  verifyOperatorSession,
} from '@/lib/operator-auth';
import { serverApiBaseUrl } from '@/lib/server-api-url';

type GenerateRequest = {
  run_id?: unknown;
};

function isSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return origin === new URL(request.url).origin
    && (!fetchSite || fetchSite === 'same-origin');
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginWrite(request)) {
    return Response.json({ error: '同一画面からの操作のみ受け付けます' }, { status: 403 });
  }

  const apiToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!apiToken || apiToken.length < 32) {
    return Response.json({ error: '実行APIの認証設定がありません' }, { status: 503 });
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

  let payload: GenerateRequest;
  try {
    payload = await request.json() as GenerateRequest;
  } catch {
    return Response.json({ error: 'run_idをJSONで指定してください' }, { status: 400 });
  }
  if (typeof payload.run_id !== 'string' || !payload.run_id.trim()) {
    return Response.json({ error: 'run_idは必須です' }, { status: 400 });
  }

  const apiBaseUrl = serverApiBaseUrl();
  const upstreamUrl = new URL('/api/jobs/generate', apiBaseUrl);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...(operatorEmail ? { 'X-Haraka-Operator-Email': operatorEmail } : {}),
        ...(operatorEmail ? { 'X-Haraka-Audit-Target-Id': payload.run_id.trim() } : {}),
      },
      body: JSON.stringify({ run_id: payload.run_id.trim() }),
      cache: 'no-store',
      signal: request.signal,
    });
  } catch (error) {
    return Response.json({
      error: '実行APIに接続できません',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }

  const responseHeaders = new Headers();
  const responseType = upstream.headers.get('content-type');
  if (responseType) responseHeaders.set('Content-Type', responseType);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
