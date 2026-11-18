import crypto from "node:crypto";
import { Hono } from "hono";
import {
  isPostingKind,
  MAX_POST_IMAGES,
  validatePostText,
  type PostingDocument,
  type PostingImage,
  type PostingPlan,
} from "@haraka/shared";
import { createSupabaseClient } from "../lib/supabase.js";
import { STORE_NAME } from "../lib/store-scope.js";
import { getXCredentials, xSetupStatus } from "../lib/x-auth.js";
import {
  lookupTweet,
  postTweet,
  uploadMedia,
  XApiError,
} from "../lib/x-client.js";

export const postingRoutes = new Hono();
const dbClient = () => createSupabaseClient() as any;
const publicFields =
  "id,status,revision,created_at,updated_at,lease_expires_at,thread_head_tweet_id,posting_data";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
type PrivatePlan = PostingPlan & {
  lease_token: string | null;
  x_credential_id: string;
};
function publicPlan(p: PrivatePlan): PostingPlan {
  const {
    id,
    status,
    revision,
    created_at,
    updated_at,
    lease_expires_at,
    thread_head_tweet_id,
    posting_data,
  } = p;
  return {
    id,
    status,
    revision,
    created_at,
    updated_at,
    lease_expires_at,
    thread_head_tweet_id,
    posting_data,
  };
}
async function readPlan(db: any, id: string): Promise<PrivatePlan> {
  if (!uuid(id)) throw new Error("投稿が見つかりません");
  const { data, error } = await db
    .from("post_plan")
    .select("*")
    .eq("id", id)
    .eq("store", STORE_NAME)
    .not("posting_data", "is", null)
    .maybeSingle();
  if (error || !data) throw new Error("投稿が見つかりません");
  return data;
}
export async function transition(
  db: any,
  id: string,
  revision: number,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<PrivatePlan> {
  const { data, error } = await db.rpc("x_post_transition", {
    p_store: STORE_NAME,
    p_id: id,
    p_revision: revision,
    p_action: action,
    p_payload: payload,
  });
  if (error) throw new Error(error.message || "投稿の状態を保存できません");
  return data;
}
export function imageStorageKey(url: string): string {
  const parsed = new URL(url),
    base = new URL(process.env.SUPABASE_URL!);
  const prefix = "/storage/v1/object/public/haraka-images/";
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(prefix))
    throw new Error("投稿画像の保存先が不正です");
  const key = decodeURIComponent(parsed.pathname.slice(prefix.length));
  if (
    !key ||
    key.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("投稿画像の保存先が不正です");
  return key;
}
function validateDocument(d: PostingDocument) {
  for (const item of d.items) {
    const error = validatePostText(item.text, item.images.length > 0);
    if (error) throw new Error(error);
    if (item.images.length > 4) throw new Error("1投稿の画像は4枚までです");
  }
}
postingRoutes.get("/posting/runs", async (c) => {
  const kind = c.req.query("kind");
  if (!isPostingKind(kind))
    return c.json({ error: "用途を選択してください" }, 400);
  const { data, error } = await dbClient()
    .from("generated_page")
    .select("run_id,created_at,run:run_id!inner(store,started_at)")
    .eq("run.store", STORE_NAME)
    .eq("kind", kind)
    .eq("status", "generated")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return c.json({ error: "買取表の一覧を取得できません" }, 500);
  const runs = new Map<string, { id: string; started_at: string }>();
  for (const p of data || [])
    if (!runs.has(p.run_id))
      runs.set(p.run_id, { id: p.run_id, started_at: p.run.started_at });
  return c.json([...runs.values()].slice(0, 30));
});
postingRoutes.get("/posting/images", async (c) => {
  const kind = c.req.query("kind"),
    run = c.req.query("run_id");
  if (!isPostingKind(kind) || !uuid(run))
    return c.json({ error: "用途と作成日を選択してください" }, 400);
  const { data, error } = await dbClient()
    .from("generated_page")
    .select(
      "id,run_id,franchise,page_index,page_label,display_name,image_url,kind,run:run_id!inner(store)",
    )
    .eq("run.store", STORE_NAME)
    .eq("run_id", run)
    .eq("kind", kind)
    .eq("status", "generated")
    .not("image_url", "is", null)
    .order("franchise")
    .order("page_index")
    .limit(1000);
  if (error) return c.json({ error: "画像を取得できません" }, 500);
  return c.json((data || []).map(({ run: _, ...p }: any) => p));
});
postingRoutes.get("/posting/plans", async (c) => {
  const { data, error } = await dbClient()
    .from("post_plan")
    .select(publicFields)
    .eq("store", STORE_NAME)
    .not("posting_data", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error)
    return c.json(
      { error: "投稿履歴を取得できません。DBの更新状況を確認してください" },
      503,
    );
  return c.json(data);
});
postingRoutes.get("/posting/plans/:id", async (c) => {
  try {
    return c.json(publicPlan(await readPlan(dbClient(), c.req.param("id"))));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});
postingRoutes.post("/posting/plans", async (c) => {
  const body = await c.req.json(),
    db = dbClient();
  if (
    !uuid(body.id) ||
    !uuid(body.run_id) ||
    !uuid(body.credential_id) ||
    !isPostingKind(body.kind) ||
    !Array.isArray(body.page_ids) ||
    !body.page_ids.length ||
    body.page_ids.length > MAX_POST_IMAGES ||
    body.page_ids.some((id: unknown) => !uuid(id)) ||
    new Set(body.page_ids).size !== body.page_ids.length
  )
    return c.json({ error: "用途・投稿先・画像を確認してください" }, 400);
  const { data: existing, error: existingError } = await db
    .from("post_plan")
    .select(publicFields)
    .eq("store", STORE_NAME)
    .eq("id", body.id)
    .maybeSingle();
  if (existingError)
    return c.json({ error: "下書きの状態を確認できません" }, 503);
  if (existing) return c.json(existing);
  const snapshots: string[] = [];
  let cleanupSafe = true;
  try {
    const { data: account, error: accountError } = await db
      .from("x_credential")
      .select("id,x_user_id,x_username,account_name,posting_kind,status")
      .eq("store", STORE_NAME)
      .eq("id", body.credential_id)
      .maybeSingle();
    if (
      accountError ||
      !account ||
      account.status !== "active" ||
      account.posting_kind !== body.kind
    )
      throw new Error("選択した用途の認証済みアカウントを選択してください");
    const { data: pages, error: pagesError } = await db
      .from("generated_page")
      .select(
        "id,image_url,page_label,display_name,page_index,franchise,run:run_id!inner(store)",
      )
      .eq("run.store", STORE_NAME)
      .eq("run_id", body.run_id)
      .eq("kind", body.kind)
      .eq("status", "generated")
      .in("id", body.page_ids);
    if (pagesError || pages?.length !== body.page_ids.length)
      throw new Error(
        "画像が更新されたか、用途・店舗が一致しません。画像を選び直してください",
      );
    const textError = validatePostText(body.text, true);
    if (textError) throw new Error(textError);
    const ordered = body.page_ids.map((id: string) =>
      pages.find((p: any) => p.id === id),
    );
    const doc: PostingDocument = {
      version: 2,
      kind: body.kind,
      account: {
        id: account.id,
        user_id: account.x_user_id,
        username: account.x_username,
        name: account.account_name,
      },
      items: [],
    };
    const batch = crypto.randomUUID();
    for (let offset = 0; offset < ordered.length; offset += 4) {
      const images: PostingImage[] = [];
      for (const page of ordered.slice(offset, offset + 4)) {
        const source = imageStorageKey(page.image_url);
        const key = `stores/${STORE_NAME}/x-posts/${body.id}/${batch}/${page.id}`;
        const { error: copyError } = await db.storage
          .from("haraka-images")
          .copy(source, key);
        if (copyError)
          throw new Error(
            "下書きの画像を保存できませんでした。もう一度お試しください",
          );
        snapshots.push(key);
        const {
          data: { publicUrl },
        } = db.storage.from("haraka-images").getPublicUrl(key);
        images.push({
          page_id: page.id,
          label:
            page.display_name ||
            page.page_label ||
            `${page.franchise} ${page.page_index + 1}`,
          url: publicUrl,
          key,
        });
      }
      doc.items.push({
        id: crypto.randomUUID(),
        text: offset === 0 ? body.text.normalize("NFC") : "",
        images,
        status: "pending",
      });
    }
    // A lost insert acknowledgement may still mean the draft was committed.
    // Keep its snapshots until a read proves another request owns the draft.
    cleanupSafe = false;
    const { data, error } = await db
      .from("post_plan")
      .insert({
        id: body.id,
        store: STORE_NAME,
        run_id: body.run_id,
        franchise: ordered[0].franchise,
        x_credential_id: account.id,
        header_text: body.text,
        status: "draft",
        posting_data: doc,
        revision: 0,
        created_by: c.req.header("x-haraka-operator-email"),
      })
      .select(publicFields)
      .single();
    if (error) {
      const { data: winner } = await db
        .from("post_plan")
        .select(publicFields)
        .eq("store", STORE_NAME)
        .eq("id", body.id)
        .maybeSingle();
      if (winner) {
        const savedKeys = new Set(
          winner.posting_data?.items.flatMap((item: any) =>
            item.images.map((image: any) => image.key),
          ) || [],
        );
        cleanupSafe = snapshots.every((key) => !savedKeys.has(key));
        return c.json(winner);
      }
      throw new Error(
        "下書きの保存結果を確認できません。同じ画面からもう一度お試しください",
      );
    }
    return c.json(data, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  } finally {
    if (cleanupSafe && snapshots.length)
      await db.storage.from("haraka-images").remove(snapshots);
  }
});
postingRoutes.patch("/posting/plans/:id", async (c) => {
  try {
    const db = dbClient(),
      p = await readPlan(db, c.req.param("id")),
      body = await c.req.json();
    if (
      !Number.isInteger(body.revision) ||
      !Array.isArray(body.texts) ||
      body.texts.length !== p.posting_data.items.length
    )
      throw new Error("下書きを再読み込みしてください");
    body.texts.forEach((text: unknown, i: number) => {
      const error = validatePostText(
        text,
        p.posting_data.items[i].images.length > 0,
      );
      if (error) throw new Error(error);
    });
    return c.json(
      publicPlan(
        await transition(db, p.id, body.revision, "edit", {
          texts: body.texts,
        }),
      ),
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

// One durable step per request. The browser continues only after a recorded receipt.
// Closing a tab pauses between posts; restarting never re-sends a confirmed item.
export async function sendNextPost(
  db: any,
  id: string,
  revision: number,
  accountUserId: string,
): Promise<PostingPlan> {
  if (!xSetupStatus().ready)
    throw new Error("X連携の本番設定が完了していません");
  const before = await readPlan(db, id);
  validateDocument(before.posting_data);
  let p = await transition(db, id, revision, "claim", {
    account_user_id: accountUserId,
  });
  const token = p.lease_token!;
  const index = p.posting_data.items.findIndex((i) => i.status !== "posted");
  const item = p.posting_data.items[index];
  let sending = false;
  let receipt: string | null = null;
  try {
    const { accessToken } = await getXCredentials(p.x_credential_id, token);
    const mediaIds: string[] = [];
    for (const img of item.images) {
      if (
        img.key !== imageStorageKey(img.url) ||
        !img.key.startsWith(`stores/${STORE_NAME}/x-posts/${p.id}/`)
      )
        throw new Error("保存済みの投稿画像が不正です");
      const { data: blob, error } = await db.storage
        .from("haraka-images")
        .download(img.key);
      if (error || !blob) throw new Error("投稿画像を読み込めませんでした");
      mediaIds.push(
        await uploadMedia(
          accessToken,
          Buffer.from(await blob.arrayBuffer()),
          blob.type || "image/png",
        ),
      );
    }
    p = await transition(db, id, p.revision, "sending", { token });
    sending = true;
    const previous =
      index > 0 ? p.posting_data.items[index - 1].tweet_id : undefined;
    if (index > 0 && !previous) throw new Error("直前の投稿結果がありません");
    const result = await postTweet(accessToken, {
      text: item.text,
      media_ids: mediaIds,
      reply_to: previous || undefined,
    });
    receipt = result.id;
    return publicPlan(
      await transition(db, id, p.revision, "finish", {
        token,
        status: "posted",
        tweet_id: receipt,
      }),
    );
  } catch (e) {
    // If X accepted the post but the DB reply was lost, preserve the receipt.
    if (receipt) {
      const current = await readPlan(db, id);
      if (current.posting_data.items[index].tweet_id === receipt)
        return publicPlan(current);
      return publicPlan(
        await transition(db, id, p.revision, "finish", {
          token,
          status: "posted",
          tweet_id: receipt,
        }),
      );
    }
    const ambiguous = sending && (!(e instanceof XApiError) || e.ambiguous);
    return publicPlan(
      await transition(db, id, p.revision, "finish", {
        token,
        status: ambiguous ? "unknown" : "failed",
        error: e instanceof Error ? e.message : "投稿処理を中断しました",
      }),
    );
  }
}
postingRoutes.post("/posting/plans/:id/step", async (c) => {
  const body = await c.req.json();
  if (
    !Number.isInteger(body.revision) ||
    typeof body.account_user_id !== "string"
  )
    return c.json({ error: "投稿先と下書きを確認してください" }, 400);
  try {
    return c.json(
      await sendNextPost(
        dbClient(),
        c.req.param("id"),
        body.revision,
        body.account_user_id,
      ),
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});
postingRoutes.post("/posting/plans/:id/recover", async (c) => {
  try {
    const body = await c.req.json();
    if (!Number.isInteger(body.revision))
      throw new Error("下書きを再読み込みしてください");
    return c.json(
      publicPlan(
        await transition(
          dbClient(),
          c.req.param("id"),
          body.revision,
          "recover",
        ),
      ),
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});
postingRoutes.post("/posting/plans/:id/resolve", async (c) => {
  try {
    const db = dbClient(),
      p = await readPlan(db, c.req.param("id")),
      body = await c.req.json();
    if (!Number.isInteger(body.revision))
      throw new Error("結果を再読み込みしてください");
    const index = p.posting_data.items.findIndex((i) => i.status !== "posted"),
      item = p.posting_data.items[index];
    if (item?.status !== "unknown")
      throw new Error("確認待ちの投稿がありません");
    let payload: Record<string, unknown>;
    if (body.confirm_not_posted === true) payload = { status: "failed" };
    else {
      const match =
        typeof body.tweet_url === "string" &&
        body.tweet_url.match(
          /^https:\/\/(?:x\.com|twitter\.com)\/(?:[A-Za-z0-9_]+|i)\/status\/(\d+)(?:\?.*)?$/,
        );
      if (!match) throw new Error("投稿URLを入力してください");
      const { accessToken } = await getXCredentials(p.x_credential_id);
      const tweet = await lookupTweet(accessToken, match[1]);
      let text = tweet.text;
      for (const url of tweet.entities?.urls || []) {
        const isAttachment = url.expanded_url.includes(
          "/status/" + tweet.id + "/photo/",
        );
        text = text.replace(url.url, isAttachment ? "" : url.expanded_url);
      }
      const expectedReply =
        index > 0 ? p.posting_data.items[index - 1].tweet_id : undefined;
      if (
        tweet.author_id !== p.posting_data.account.user_id ||
        (tweet.referenced_tweets || []).find((r) => r.type === "replied_to")
          ?.id !== expectedReply ||
        (tweet.attachments?.media_keys?.length || 0) !== item.images.length ||
        text.normalize("NFC").trim() !== item.text.normalize("NFC").trim()
      )
        throw new Error(
          "アカウント・本文・画像枚数・返信先が下書きと一致しません",
        );
      payload = { status: "posted", tweet_id: tweet.id };
    }
    return c.json(
      publicPlan(await transition(db, p.id, body.revision, "resolve", payload)),
    );
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});
