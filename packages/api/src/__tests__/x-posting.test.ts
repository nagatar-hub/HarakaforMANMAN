import assert from "node:assert/strict";
import { before, beforeEach, after, afterEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import {
  validatePostText,
  postTextLength,
  type PostingDocument,
} from "@haraka/shared";
import { postingAccess } from "../lib/posting-access.js";
import {
  sealXSecret,
  openXSecret,
  generateCodeChallenge,
} from "../lib/x-auth.js";
import { sendNextPost, imageStorageKey } from "../routes/posting.js";
import { XApiError, postTweet, uploadMedia } from "../lib/x-client.js";
import { STORE_NAME } from "../lib/store-scope.js";

const db = new PGlite();
const accountId = "10000000-0000-4000-8000-000000000001";
const planId = "20000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);
before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE x_credential (
      id uuid PRIMARY KEY,store text NOT NULL,account_name text,x_user_id text,x_username text,status text DEFAULT 'active',
      access_token text,refresh_token text,token_expires_at timestamptz,last_verified_at timestamptz,
      is_default boolean DEFAULT false,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE post_plan (
      id uuid PRIMARY KEY,store text NOT NULL,run_id uuid,franchise text,template_id uuid,banner_id uuid,banner_position text,
      x_credential_id uuid REFERENCES x_credential(id),header_text text,status text DEFAULT 'draft',thread_head_tweet_id text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
    );
  `);
  await db.exec(
    await readFile(
      path.resolve(
        __dirname,
        "../../../../supabase/migrations/20261118072951_x_manual_posting.sql",
      ),
      "utf8",
    ),
  );
});
beforeEach(async () => {
  globalThis.fetch = originalFetch;
  process.env.SUPABASE_URL = "https://posting-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test-only";
  process.env.X_CLIENT_ID = "test-client";
  process.env.X_CLIENT_SECRET = "test-secret";
  process.env.X_OAUTH_CALLBACK_URL =
    "https://haraka.test/api/posting/x/oauth/callback";
  process.env.X_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.ORDER_LIST_IMPORT_API_TOKEN = "a".repeat(32);
  await db.exec("TRUNCATE post_plan,x_credential,x_oauth_request CASCADE");
  await db.query(
    `INSERT INTO x_credential(id,store,account_name,x_user_id,x_username,posting_kind,access_token,refresh_token,token_expires_at)
    VALUES($1,$2,'店頭アカウント','123','store_account','store','test-access','test-refresh',now()+interval '1 hour')`,
    [accountId, STORE_NAME],
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(async () => {
  await db.close();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
function document(items = 2): PostingDocument {
  return {
    version: 2,
    kind: "store",
    account: {
      id: accountId,
      user_id: "123",
      username: "store_account",
      name: "店頭アカウント",
    },
    items: Array.from({ length: items }, (_, i) => ({
      id: crypto.randomUUID(),
      text: i === 0 ? "本日の買取表" : "",
      status: "pending",
      images: [
        {
          page_id: crypto.randomUUID(),
          label: "画像" + i,
          key: `stores/${STORE_NAME}/x-posts/${planId}/test/image`,
          url: `https://posting-test.supabase.co/storage/v1/object/public/haraka-images/stores/${STORE_NAME}/x-posts/${planId}/test/image`,
        },
      ],
    })),
  };
}
async function seed(items = 2, id = planId, doc = document(items)) {
  await db.query(
    "INSERT INTO post_plan(id,store,x_credential_id,posting_data) VALUES($1,$2,$3,$4)",
    [id, STORE_NAME, accountId, JSON.stringify(doc)],
  );
}
async function read(id = planId) {
  return (await db.query<any>("SELECT * FROM post_plan WHERE id=$1", [id]))
    .rows[0];
}
async function command(
  action: string,
  revision: number,
  payload: Record<string, unknown> = {},
  store = STORE_NAME,
  id = planId,
) {
  return (
    await db.query<{ result: any }>(
      "SELECT x_post_transition($1,$2,$3,$4,$5) AS result",
      [store, id, revision, action, JSON.stringify(payload)],
    )
  ).rows[0].result;
}
async function claim(revision = 0, id = planId) {
  return command("claim", revision, { account_user_id: "123" }, STORE_NAME, id);
}
test("X text weighting handles Japanese, emoji, URLs and unresolved variables", () => {
  assert.equal(postTextLength("日".repeat(140)), 280);
  assert.equal(
    validatePostText("日".repeat(141)),
    "投稿文はXの通常投稿の上限（日本語は約140字）以内にしてください",
  );
  assert.equal(postTextLength("https://example.com/a/very/long/path"), 23);
  assert.equal(postTextLength("👨‍👩‍👧‍👦"), 2);
  assert.equal(validatePostText("", true), null);
  assert.ok(validatePostText("{{date}}", true));
});
test("OAuth secrets are authenticated ciphertext and PKCE follows RFC7636", () => {
  const sealed = sealXSecret("secret-token");
  assert.ok(!sealed.includes("secret-token"));
  assert.equal(openXSecret(sealed), "secret-token");
  assert.throws(() => openXSecret(sealed.slice(0, -5) + "AAAAA"));
  assert.equal(
    generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
test("posting API requires both trusted backend token and operator identity", async () => {
  const app = new Hono();
  app.use("*", postingAccess);
  app.get("/test", (c) => c.json({ ok: true }));
  assert.equal((await app.request("/test")).status, 401);
  assert.equal(
    (
      await app.request("/test", {
        headers: { Authorization: "Bearer " + "a".repeat(32) },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request("/test", {
        headers: {
          Authorization: "Bearer " + "a".repeat(32),
          "X-Haraka-Operator-Email": "operator@example.com",
        },
      })
    ).status,
    200,
  );
});
test("snapshot URLs cannot point to external or traversal paths", () => {
  assert.equal(
    imageStorageKey(
      "https://posting-test.supabase.co/storage/v1/object/public/haraka-images/stores/test/image.png",
    ),
    "stores/test/image.png",
  );
  assert.throws(() => imageStorageKey("http://169.254.169.254/metadata"));
  assert.throws(() =>
    imageStorageKey(
      "https://evil.test/storage/v1/object/public/haraka-images/a",
    ),
  );
});
test("database rejects cross-store plan access, account changes and stale edits", async () => {
  await seed();
  await assert.rejects(
    command("claim", 0, { account_user_id: "123" }, "another-store"),
    /見つかりません/,
  );
  await assert.rejects(
    command("claim", 0, { account_user_id: "wrong" }),
    /投稿先/,
  );
  await db.query("UPDATE x_credential SET posting_kind='postal' WHERE id=$1", [
    accountId,
  ]);
  await assert.rejects(claim(), /用途/);
  await db.query("UPDATE x_credential SET posting_kind='store' WHERE id=$1", [
    accountId,
  ]);
  await command("edit", 0, { texts: ["修正", ""] });
  await assert.rejects(claim(0), /再読み込み/);
});
test("concurrent claims yield exactly one sender, and same-account plans serialize", async () => {
  await seed();
  const results = await Promise.allSettled([claim(), claim()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const second = "20000000-0000-4000-8000-000000000002";
  await seed(2, second);
  await assert.rejects(claim(0, second), /処理中/);
});
test("expired preparation retries safely; expired send becomes unknown and blocks resend", async () => {
  await seed();
  let p = await claim();
  await db.query(
    "UPDATE post_plan SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [planId],
  );
  p = await command("recover", p.revision);
  assert.equal(p.posting_data.items[0].status, "failed");
  p = await claim(p.revision);
  p = await command("sending", p.revision, { token: p.lease_token });
  await db.query(
    "UPDATE post_plan SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [planId],
  );
  p = await command("recover", p.revision);
  assert.equal(p.posting_data.items[0].status, "unknown");
  await assert.rejects(claim(p.revision), /確認/);
  p = await command("resolve", p.revision, {
    status: "posted",
    tweet_id: "999",
  });
  assert.equal(p.thread_head_tweet_id, "999");
  p = await claim(p.revision);
  assert.equal(p.posting_data.items[1].status, "preparing");
});
test("confirmed posts remain immutable and repeated finish cannot overwrite a receipt", async () => {
  await seed(1);
  let p = await claim();
  p = await command("sending", p.revision, { token: p.lease_token });
  const rev = p.revision,
    token = p.lease_token;
  p = await command("finish", rev, {
    token,
    status: "posted",
    tweet_id: "1001",
  });
  assert.equal(p.status, "completed");
  assert.equal(p.lease_token, null);
  await assert.rejects(
    command("finish", rev, { token, status: "posted", tweet_id: "1002" }),
    /再読み込み/,
  );
  await assert.rejects(claim(p.revision), /完了/);
  assert.equal((await read()).thread_head_tweet_id, "1001");
});
test("RLS and grants keep credentials, OAuth state and transition functions server-only", async () => {
  const grants = await db.query<{ allowed: boolean }>(
    "SELECT has_function_privilege('anon','public.x_post_transition(text,uuid,integer,text,jsonb)','EXECUTE') AS allowed",
  );
  assert.equal(grants.rows[0].allowed, false);
  await db.exec("SET ROLE anon");
  try {
    await assert.rejects(
      db.query("SELECT access_token FROM x_credential"),
      /permission denied/,
    );
  } finally {
    await db.exec("RESET ROLE");
  }
});
function adapter() {
  return {
    from: () => {
      const filters: Record<string, string> = {};
      const q: any = {
        select: () => q,
        eq: (key: string, value: string) => {
          filters[key] = value;
          return q;
        },
        not: () => q,
        maybeSingle: async () => ({
          data:
            (
              await db.query<any>(
                "SELECT * FROM post_plan WHERE id=$1 AND store=$2",
                [filters.id, filters.store],
              )
            ).rows[0] || null,
          error: null,
        }),
      };
      return q;
    },
    rpc: async (_name: string, args: any) => {
      try {
        return {
          data: await command(
            args.p_action,
            args.p_revision,
            args.p_payload,
            args.p_store,
            args.p_id,
          ),
          error: null,
        };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([png], { type: "image/png" }),
          error: null,
        }),
      }),
    },
  };
}
function mockNetwork(onPost: (body: any) => Response | Promise<Response>) {
  const calls: { media: number; posts: any[] } = { media: 0, posts: [] };
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (
      url.hostname === "posting-test.supabase.co" &&
      url.pathname === "/rest/v1/x_credential"
    ) {
      assert.equal(url.searchParams.get("store"), "eq." + STORE_NAME);
      const id = url.searchParams.get("id")!.slice(3),
        lease = url.searchParams.get("lease_token")!.slice(3);
      const rows = (
        await db.query(
          "SELECT * FROM x_credential WHERE id=$1 AND lease_token=$2",
          [id, lease],
        )
      ).rows;
      return Response.json(rows);
    }
    assert.equal(url.hostname, "api.x.com", "Unexpected network target");
    if (url.pathname === "/2/media/upload") {
      calls.media++;
      assert.ok(init?.body instanceof FormData);
      return Response.json({ data: { id: "media" + calls.media } });
    }
    if (url.pathname === "/2/tweets") {
      const body = JSON.parse(String(init?.body));
      calls.posts.push(body);
      return onPost(body);
    }
    throw new Error("Unexpected request " + url.pathname);
  };
  return calls;
}
test("full posting engine uploads v2 media, persists receipts, and replies in order", async () => {
  await seed();
  let n = 0;
  const calls = mockNetwork(() =>
    Response.json({ data: { id: String(500 + ++n), text: "ok" } }),
  );
  let p = await sendNextPost(adapter(), planId, 0, "123");
  assert.equal(p.posting_data.items[0].tweet_id, "501");
  assert.equal(p.status, "posting");
  assert.equal((p as any).lease_token, undefined);
  p = await sendNextPost(adapter(), planId, p.revision, "123");
  assert.equal(p.status, "completed");
  assert.equal(calls.media, 2);
  assert.deepEqual(calls.posts[1].reply, { in_reply_to_tweet_id: "501" });
  await assert.rejects(sendNextPost(adapter(), planId, p.revision, "123"));
  assert.equal(calls.posts.length, 2);
});
test("X timeout becomes unknown, sends no later items, and cannot auto-retry", async () => {
  await seed();
  const calls = mockNetwork(() => {
    throw new Error("socket closed");
  });
  const p = await sendNextPost(adapter(), planId, 0, "123");
  assert.equal(p.status, "partial");
  assert.equal(p.posting_data.items[0].status, "unknown");
  assert.equal(p.posting_data.items[1].status, "pending");
  await assert.rejects(sendNextPost(adapter(), planId, p.revision, "123"));
  assert.equal(calls.posts.length, 1);
});
test("rate limit stops at first failure; explicit retry preserves prior replies", async () => {
  await seed();
  let fails = true;
  const calls = mockNetwork(() =>
    fails
      ? new Response("", { status: 429 })
      : Response.json({ data: { id: "700" } }),
  );
  let p = await sendNextPost(adapter(), planId, 0, "123");
  assert.equal(p.posting_data.items[0].status, "failed");
  assert.equal(p.posting_data.items[1].status, "pending");
  fails = false;
  p = await sendNextPost(adapter(), planId, p.revision, "123");
  assert.equal(p.posting_data.items[0].tweet_id, "700");
  assert.equal(calls.posts.length, 2);
});
test("lost database acknowledgement after X success uses the saved receipt without reposting", async () => {
  await seed(1);
  const calls = mockNetwork(() => Response.json({ data: { id: "800" } }));
  const api = adapter(),
    rpc = api.rpc;
  let lost = false;
  api.rpc = async (name, args) => {
    const result = await rpc(name, args);
    if (args.p_action === "finish" && !lost) {
      lost = true;
      return { data: null, error: { message: "lost acknowledgement" } };
    }
    return result;
  };
  const p = await sendNextPost(api, planId, 0, "123");
  assert.equal(p.status, "completed");
  assert.equal(p.thread_head_tweet_id, "800");
  assert.equal(calls.posts.length, 1);
});
test("X errors never reflect remote response bodies or secrets", async () => {
  globalThis.fetch = async () =>
    new Response("access_token=DO_NOT_SHOW", { status: 403 });
  await assert.rejects(
    postTweet("private-token", { text: "test" }),
    (e: any) =>
      e instanceof XApiError &&
      !e.message.includes("DO_NOT_SHOW") &&
      !e.ambiguous,
  );
  await assert.rejects(
    uploadMedia("private-token", Buffer.alloc(5 * 1024 * 1024 + 1)),
    /5MB/,
  );
});

test("HTTP workflow freezes selected images, filters channel/account ownership and records a complete thread", async () => {
  const { postingRoutes } = await import("../routes/posting.js");
  const sourceRun = "30000000-0000-4000-8000-000000000001";
  const pages = Array.from({ length: 5 }, (_, i) => ({
    id: `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    run_id: sourceRun,
    kind: "store",
    status: "generated",
    franchise: "Pokemon",
    page_index: i,
    page_label: "画像" + i,
    display_name: "店頭 " + i,
    image_url: `https://posting-test.supabase.co/storage/v1/object/public/haraka-images/original/${i}.png`,
    run: { store: STORE_NAME },
  }));
  const objects = new Map<string, Buffer>(
    pages.map((_, i) => ["original/" + i + ".png", Buffer.from(png)]),
  );
  const posts: any[] = [];
  let loseInsertAck = false;
  let failDraftRead = false;
  let insertCommitted = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method =
      init?.method || (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.hostname === "api.x.com") {
      if (url.pathname === "/2/media/upload")
        return Response.json({ data: { id: "media-1" } });
      if (url.pathname === "/2/tweets") {
        posts.push(body);
        return Response.json({ data: { id: String(900 + posts.length) } });
      }
      throw new Error("Unexpected X request");
    }
    assert.equal(url.hostname, "posting-test.supabase.co");
    if (url.pathname === "/storage/v1/object/copy") {
      assert.ok(objects.has(body.sourceKey));
      objects.set(
        body.destinationKey,
        Buffer.from(objects.get(body.sourceKey)!),
      );
      return Response.json({ Key: body.destinationKey });
    }
    if (url.pathname.startsWith("/storage/v1/object/haraka-images/")) {
      const key = decodeURIComponent(
        url.pathname.slice("/storage/v1/object/haraka-images/".length),
      );
      return new Response(new Uint8Array(objects.get(key)!), {
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url.pathname === "/rest/v1/rpc/x_post_transition") {
      try {
        return Response.json(
          await command(
            body.p_action,
            body.p_revision,
            body.p_payload,
            body.p_store,
            body.p_id,
          ),
        );
      } catch (e) {
        return Response.json(
          { message: (e as Error).message, code: "40001" },
          { status: 409 },
        );
      }
    }
    const table = url.pathname.split("/").pop()!;
    let rows: any[] = [];
    if (table === "generated_page") {
      const ids = url.searchParams.get("id")?.slice(4, -1).split(",");
      rows = pages.filter(
        (p) =>
          p.run.store === url.searchParams.get("run.store")?.slice(3) &&
          p.kind === url.searchParams.get("kind")?.slice(3) &&
          p.run_id === url.searchParams.get("run_id")?.slice(3) &&
          (!ids || ids.includes(p.id)),
      );
    } else if (table === "x_credential" || table === "post_plan") {
      if (method === "POST") {
        assert.equal(table, "post_plan");
        const keys = Object.keys(body),
          allowed = new Set([
            "id",
            "store",
            "run_id",
            "franchise",
            "x_credential_id",
            "header_text",
            "status",
            "posting_data",
            "revision",
            "created_by",
          ]);
        assert.ok(keys.every((key) => allowed.has(key)));
        const values = keys.map((key) =>
          key === "posting_data" ? JSON.stringify(body[key]) : body[key],
        );
        rows = (
          await db.query(
            "INSERT INTO post_plan(" +
              keys.join(",") +
              ") VALUES(" +
              keys.map((_, i) => "$" + (i + 1)).join(",") +
              ") RETURNING *",
            values,
          )
        ).rows;
        if (loseInsertAck) {
          insertCommitted = true;
          return Response.json(
            { message: "lost insert response" },
            { status: 503 },
          );
        }
      } else {
        if (table === "post_plan" && insertCommitted && failDraftRead)
          return Response.json(
            { message: "temporary read failure" },
            { status: 503 },
          );
        rows = (await db.query("SELECT * FROM " + table)).rows;
        for (const [key, value] of url.searchParams) {
          if (value.startsWith("eq."))
            rows = rows.filter((r) => String(r[key]) === value.slice(3));
          if (value === "not.is.null")
            rows = rows.filter((r) => r[key] !== null);
        }
      }
    } else throw new Error("Unexpected request " + url);
    const select = url.searchParams.get("select");
    if (select && select !== "*" && !select.includes("!inner"))
      rows = rows.map((r) =>
        Object.fromEntries(select.split(",").map((key) => [key, r[key]])),
      );
    return Response.json(
      headers.get("accept")?.includes("vnd.pgrst.object") ? rows[0] : rows,
      { status: method === "POST" ? 201 : 200 },
    );
  };
  const app = new Hono();
  app.use("*", postingAccess);
  app.route("/api", postingRoutes);
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + "a".repeat(32),
    "X-Haraka-Operator-Email": "operator@example.com",
  };
  const input = {
    id: planId,
    run_id: sourceRun,
    credential_id: accountId,
    kind: "store",
    page_ids: pages.map((p) => p.id).reverse(),
    text: "買取表",
  };
  const wrong = await app.request("/api/posting/plans", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, kind: "postal" }),
  });
  assert.equal(wrong.status, 400);
  assert.equal(objects.size, 5);
  const draft = await app.request("/api/posting/plans", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(draft.status, 201, await draft.clone().text());
  let result = (await draft.json()) as any;
  assert.equal(result.posting_data.items.length, 2);
  assert.equal(result.posting_data.items[0].images[0].page_id, pages[4].id);
  assert.equal(posts.length, 0, "Creating a draft must never publish");
  const key = result.posting_data.items[0].images[0].key;
  objects.set("original/4.png", Buffer.from("regenerated"));
  assert.deepEqual(
    objects.get(key),
    png,
    "The draft snapshot must remain unchanged",
  );
  const duplicate = await app.request("/api/posting/plans", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(duplicate.status, 200);
  assert.equal(objects.size, 10);
  const otherAccount = "10000000-0000-4000-8000-000000000009";
  await db.query(
    "INSERT INTO x_credential(id,store,account_name,x_user_id,x_username,posting_kind) VALUES($1,'other-store','他店舗','456','other','store')",
    [otherAccount],
  );
  const wrongStore = await app.request("/api/posting/plans", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...input,
      id: crypto.randomUUID(),
      credential_id: otherAccount,
    }),
  });
  assert.equal(wrongStore.status, 400);
  for (let i = 0; i < 2; i++) {
    const response = await app.request(
      "/api/posting/plans/" + planId + "/step",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          revision: result.revision,
          account_user_id: "123",
        }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    result = await response.json();
  }
  assert.equal(result.status, "completed");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].media.media_ids.length, 4);
  assert.equal(posts[1].media.media_ids.length, 1);
  assert.equal(posts[1].reply.in_reply_to_tweet_id, "901");
  const repeated = await app.request("/api/posting/plans/" + planId + "/step", {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: result.revision, account_user_id: "123" }),
  });
  assert.equal(repeated.status, 409);
  assert.equal(posts.length, 2);
  for (const readFails of [false, true]) {
    const retryId = crypto.randomUUID();
    loseInsertAck = true;
    insertCommitted = false;
    failDraftRead = readFails;
    const lostResponse = await app.request("/api/posting/plans", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, id: retryId }),
    });
    assert.equal(lostResponse.status, readFails ? 400 : 200);
    const saved = (
      await db.query<any>("SELECT * FROM post_plan WHERE id=$1", [retryId])
    ).rows[0];
    for (const item of saved.posting_data.items)
      for (const image of item.images)
        assert.ok(
          objects.has(image.key),
          "Lost acknowledgements must never delete saved draft images",
        );
    loseInsertAck = false;
    failDraftRead = false;
    const retry = await app.request("/api/posting/plans", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, id: retryId }),
    });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as any).id, retryId);
  }
});
