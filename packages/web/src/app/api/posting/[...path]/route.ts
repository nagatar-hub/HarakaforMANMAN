import { serverApiBaseUrl } from '@/lib/server-api-url';
import {
  OPERATOR_SESSION_COOKIE,
  isOperatorEmailAllowed,
  readCookie,
  verifyOperatorSession,
} from "@/lib/operator-auth";

export const maxDuration = 300;
const STATE_COOKIE = "haraka_x_oauth_state";
type RouteContext = { params: Promise<{ path: string[] }> };
const allowedPath =
  /^(?:x\/(?:setup|credentials(?:\/[0-9a-f-]+(?:\/verify)?)?|oauth\/(?:authorize|callback))|posting\/(?:runs|images|plans(?:\/[0-9a-f-]+(?:\/(?:step|recover|resolve))?)?)|post\/(?:templates|variables|banners)(?:\/[0-9a-f-]+)?)$/i;
async function proxyPosting(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const route = path.join("/");
  if (!allowedPath.test(route))
    return Response.json({ error: "Not Found" }, { status: 404 });
  const url = new URL(request.url),
    callback = route === "x/oauth/callback";
  const write = !["GET", "HEAD"].includes(request.method);
  if (
    write &&
    (request.headers.get("origin") !== url.origin ||
      (request.headers.get("sec-fetch-site") &&
        request.headers.get("sec-fetch-site") !== "same-origin"))
  ) {
    return Response.json(
      { error: "同じ画面から操作してください" },
      { status: 403 },
    );
  }
  const secret = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!secret || secret.length < 32)
    return Response.json(
      { error: "投稿APIの認証設定がありません" },
      { status: 503 },
    );
  const session = await verifyOperatorSession({
    session: readCookie(request.headers.get("cookie"), OPERATOR_SESSION_COOKIE),
    secret,
  });
  if (!session.ok || !isOperatorEmailAllowed(session.value.email))
    return Response.json(
      { error: "ログインが必要です。画面を再読み込みしてください" },
      { status: 401 },
    );
  if (
    callback &&
    (!url.searchParams.get("state") ||
      url.searchParams.get("state") !==
        readCookie(request.headers.get("cookie"), STATE_COOKIE))
  ) {
    return Response.redirect(
      new URL(
        "/post/credentials?error=" +
          encodeURIComponent(
            "認証を開始したブラウザーで、もう一度お試しください",
          ),
        url,
      ),
      303,
    );
  }
  const apiBase = serverApiBaseUrl();
  const upstream = new URL("/api/" + route, apiBase);
  upstream.search = url.search;
  let body: ArrayBuffer | undefined;
  if (write) {
    if (Number(request.headers.get("content-length")) > 1_048_576)
      return Response.json(
        { error: "リクエストが大きすぎます" },
        { status: 413 },
      );
    body = await request.arrayBuffer();
    if (body.byteLength > 1_048_576)
      return Response.json(
        { error: "リクエストが大きすぎます" },
        { status: 413 },
      );
  }
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Haraka-Operator-Email": session.value.email,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(270_000),
    });
    const data = await response.json();
    const headers = new Headers({ "Cache-Control": "no-store" });
    const cookieOptions = `Path=/api/posting/x/oauth; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`;
    if (callback) {
      headers.set(
        "Set-Cookie",
        `${STATE_COOKIE}=; Max-Age=0; ${cookieOptions}`,
      );
      const target = new URL("/post/credentials", url);
      if (response.ok && data.success)
        target.searchParams.set("success", data.username);
      else target.searchParams.set("error", data.error || "認証に失敗しました");
      headers.set("Location", target.href);
      return new Response(null, { status: 303, headers });
    }
    if (route === "x/oauth/authorize" && response.ok) {
      headers.set(
        "Set-Cookie",
        `${STATE_COOKIE}=${data.state}; Max-Age=600; ${cookieOptions}`,
      );
      return Response.json({ url: data.url }, { headers });
    }
    return Response.json(data, { status: response.status, headers });
  } catch {
    return Response.json(
      {
        error:
          "APIから結果を受信できませんでした。投稿履歴を再読み込みして確認してください",
      },
      { status: 502 },
    );
  }
}
export const GET = proxyPosting;
export const POST = proxyPosting;
export const PATCH = proxyPosting;
export const DELETE = proxyPosting;
