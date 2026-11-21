import { GET, POST } from "../app/api/posting/[...path]/route";
import {
  OPERATOR_SESSION_COOKIE,
  createOperatorSession,
} from "@/lib/operator-auth";
const original = { ...process.env },
  originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});
const context = (path: string) => ({
  params: Promise.resolve({ path: path.split("/") }),
});
async function cookie() {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = "z".repeat(32);
  process.env.API_BASE_URL = "https://internal.example";
  process.env.ORDER_LIST_OPERATOR_EMAILS = "operator@example.com";
  const session = await createOperatorSession({
    email: "operator@example.com",
    secret: "z".repeat(32),
  });
  return OPERATOR_SESSION_COOKIE + "=" + session;
}
test("posting cannot bypass operator authentication even when other features disable it", async () => {
  await cookie();
  process.env.OPERATOR_AUTH_REQUIRED = "false";
  const upstream = jest.fn();
  global.fetch = upstream;
  const response = await GET(
    new Request("https://haraka.test/api/posting/x/setup"),
    context("x/setup"),
  );
  expect(response.status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});
test("posting proxy rejects cross-origin writes and arbitrary backend routes", async () => {
  const auth = await cookie(),
    upstream = jest.fn();
  global.fetch = upstream;
  expect(
    (
      await POST(
        new Request("https://haraka.test/api/posting/posting/plans", {
          method: "POST",
          headers: { Cookie: auth, Origin: "https://evil.test" },
          body: "{}",
        }),
        context("posting/plans"),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await GET(
        new Request("https://haraka.test/api/posting/runs"),
        context("runs"),
      )
    ).status,
  ).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});
test("OAuth initiation binds state to an HttpOnly same-site browser cookie", async () => {
  const auth = await cookie();
  global.fetch = jest.fn(async () =>
    Response.json({
      url: "https://x.com/i/oauth2/authorize?state=sample",
      state: "sample",
    }),
  );
  const response = await POST(
    new Request("https://haraka.test/api/posting/x/oauth/authorize", {
      method: "POST",
      headers: {
        Cookie: auth,
        Origin: "https://haraka.test",
        "Content-Type": "application/json",
      },
      body: '{"kind":"store"}',
    }),
    context("x/oauth/authorize"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain(
    "haraka_x_oauth_state=sample;",
  );
  expect(response.headers.get("set-cookie")).toContain(
    "HttpOnly; SameSite=Lax; Secure",
  );
  expect(await response.json()).toEqual({
    url: "https://x.com/i/oauth2/authorize?state=sample",
  });
});
test("OAuth callback rejects another browser or a replaced state before reaching the backend", async () => {
  const auth = await cookie(),
    upstream = jest.fn();
  global.fetch = upstream;
  const response = await GET(
    new Request(
      "https://haraka.test/api/posting/x/oauth/callback?state=attacker&code=private",
      { headers: { Cookie: auth + "; haraka_x_oauth_state=expected" } },
    ),
    context("x/oauth/callback"),
  );
  expect(response.status).toBe(303);
  expect(upstream).not.toHaveBeenCalled();
  expect(response.headers.get("location")).not.toContain("private");
});
test("valid OAuth callback forwards trusted identity and clears state after redirect", async () => {
  const auth = await cookie();
  const upstream = jest.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ success: true, username: "store_account" }),
  );
  global.fetch = upstream;
  const response = await GET(
    new Request(
      "https://haraka.test/api/posting/x/oauth/callback?state=sample&code=test",
      {
        headers: {
          Cookie: auth + "; haraka_x_oauth_state=sample",
          "X-Haraka-Operator-Email": "spoof@example.com",
        },
      },
    ),
    context("x/oauth/callback"),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    "https://haraka.test/post/credentials?success=store_account",
  );
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  const headers = new Headers(upstream.mock.calls[0][1]?.headers);
  expect(headers.get("x-haraka-operator-email")).toBe("operator@example.com");
  expect(headers.get("authorization")).toBe("Bearer " + "z".repeat(32));
});
test("transport failure never implies an automatic retry or exposes upstream details", async () => {
  const auth = await cookie();
  global.fetch = jest.fn(async () => {
    throw new Error("secret upstream detail");
  });
  const response = await POST(
    new Request(
      "https://haraka.test/api/posting/posting/plans/00000000-0000-4000-8000-000000000001/step",
      {
        method: "POST",
        headers: { Cookie: auth, Origin: "https://haraka.test" },
        body: "{}",
      },
    ),
    context("posting/plans/00000000-0000-4000-8000-000000000001/step"),
  );
  expect(response.status).toBe(502);
  const result = await response.json();
  expect(result.error).toContain("投稿履歴");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
