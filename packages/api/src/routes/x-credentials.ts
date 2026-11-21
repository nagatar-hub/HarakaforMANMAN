import { Hono } from "hono";
import crypto from "node:crypto";
import { isPostingKind } from "@haraka/shared";
import { createSupabaseClient } from "../lib/supabase.js";
import {
  buildAuthorizationUrl,
  getVerifierForState,
  exchangeCodeForTokens,
  getXCredentials,
  sealXSecret,
  xSetupStatus,
} from "../lib/x-auth.js";
import { verifyCredentials } from "../lib/x-client.js";
import { STORE_NAME } from "../lib/store-scope.js";

export const xCredentialRoutes = new Hono();
const fields =
  "id,account_name,x_user_id,x_username,status,posting_kind,last_verified_at,token_expires_at,created_at,updated_at";
const dbClient = () => createSupabaseClient() as any;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
xCredentialRoutes.get("/x/setup", (c) =>
  c.json({ ...xSetupStatus(), store: STORE_NAME }),
);
xCredentialRoutes.get("/x/credentials", async (c) => {
  const { data, error } = await dbClient()
    .from("x_credential")
    .select(fields)
    .eq("store", STORE_NAME)
    .order("created_at");
  if (error)
    return c.json(
      {
        error:
          "Xアカウントを読み込めませんでした。DBの更新状況を確認してください",
      },
      503,
    );
  return c.json(data);
});
xCredentialRoutes.post("/x/oauth/authorize", async (c) => {
  const body = await c.req.json();
  if (!isPostingKind(body.kind))
    return c.json({ error: "店頭・郵送を選択してください" }, 400);
  let expectedUserId: string | undefined;
  if (body.credential_id) {
    if (!uuid(body.credential_id))
      return c.json({ error: "アカウントが不正です" }, 400);
    const { data, error } = await dbClient()
      .from("x_credential")
      .select("x_user_id,posting_kind")
      .eq("store", STORE_NAME)
      .eq("id", body.credential_id)
      .maybeSingle();
    if (error || !data)
      return c.json({ error: "アカウントが見つかりません" }, 404);
    expectedUserId = data.x_user_id;
    if (data.posting_kind && data.posting_kind !== body.kind)
      return c.json({ error: "登録済みの用途を選択してください" }, 400);
  }
  try {
    return c.json(
      await buildAuthorizationUrl(
        c.req.header("x-haraka-operator-email")!,
        body.kind,
        expectedUserId,
      ),
    );
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "認証を開始できません" },
      400,
    );
  }
});
xCredentialRoutes.get("/x/oauth/callback", async (c) => {
  const state = c.req.query("state");
  if (!uuid(state))
    return c.json(
      { error: "認証情報が不正です。もう一度認証してください" },
      400,
    );
  try {
    const request = await getVerifierForState(
      state,
      c.req.header("x-haraka-operator-email")!,
    );
    if (c.req.query("error") || !c.req.query("code"))
      return c.json({ error: "Xでの認証がキャンセルされました" }, 400);
    const tokens = await exchangeCodeForTokens(
      c.req.query("code")!,
      request.verifier,
    );
    const user = await verifyCredentials(tokens.access_token);
    if (request.expectedUserId && request.expectedUserId !== user.id)
      throw new Error(
        "別のXアカウントで認証されました。元のアカウントに切り替えて再認証してください",
      );
    const db = dbClient();
    const { data: existing, error } = await db
      .from("x_credential")
      .select("id,posting_kind,account_name")
      .eq("store", STORE_NAME)
      .eq("x_user_id", user.id)
      .maybeSingle();
    if (error) throw new Error("アカウントの保存先を確認できません");
    if (existing?.posting_kind && existing.posting_kind !== request.kind)
      throw new Error(
        "このXアカウントは別の用途で登録されています。アカウント管理から用途を変更してください",
      );
    const row = {
      store: STORE_NAME,
      account_name: existing?.account_name || user.name || user.username,
      x_user_id: user.id,
      x_username: user.username,
      posting_kind: request.kind,
      access_token: sealXSecret(tokens.access_token),
      refresh_token: sealXSecret(tokens.refresh_token),
      token_expires_at: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      status: "active",
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      const lease = crypto.randomUUID();
      const { data: locked, error: lockError } = await db.rpc(
        "x_account_lease",
        { p_store: STORE_NAME, p_id: existing.id, p_token: lease },
      );
      if (lockError || !locked)
        throw new Error(
          "このアカウントは投稿処理中です。終了後に再認証してください",
        );
      try {
        const { error: saveError } = await db
          .from("x_credential")
          .update(row)
          .eq("store", STORE_NAME)
          .eq("id", existing.id)
          .eq("lease_token", lease);
        if (saveError) throw new Error("認証結果を保存できませんでした");
      } finally {
        await db.rpc("x_account_lease", {
          p_store: STORE_NAME,
          p_id: existing.id,
          p_token: lease,
          p_release: true,
        });
      }
    } else {
      const { error: saveError } = await db
        .from("x_credential")
        .insert({ ...row, is_default: false });
      if (saveError)
        throw new Error(
          "認証結果を保存できませんでした。登録状況を確認してください",
        );
    }
    return c.json({ success: true, username: user.username });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "認証できませんでした" },
      400,
    );
  }
});
xCredentialRoutes.patch("/x/credentials/:id", async (c) => {
  const id = c.req.param("id"),
    body = await c.req.json();
  if (
    !uuid(id) ||
    !isPostingKind(body.posting_kind) ||
    typeof body.account_name !== "string" ||
    !body.account_name.trim() ||
    body.account_name.length > 80
  )
    return c.json({ error: "表示名と用途を入力してください" }, 400);
  const db = dbClient(),
    lease = crypto.randomUUID();
  const { data: locked, error } = await db.rpc("x_account_lease", {
    p_store: STORE_NAME,
    p_id: id,
    p_token: lease,
  });
  if (error || !locked)
    return c.json({ error: "アカウントが見つからないか、処理中です" }, 409);
  try {
    const { data, error: saveError } = await db
      .from("x_credential")
      .update({
        account_name: body.account_name.trim(),
        posting_kind: body.posting_kind,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("store", STORE_NAME)
      .eq("lease_token", lease)
      .select(fields)
      .single();
    if (saveError)
      return c.json({ error: "アカウント設定を保存できませんでした" }, 500);
    return c.json(data);
  } finally {
    await db.rpc("x_account_lease", {
      p_store: STORE_NAME,
      p_id: id,
      p_token: lease,
      p_release: true,
    });
  }
});
xCredentialRoutes.post("/x/credentials/:id/verify", async (c) => {
  try {
    const { accessToken } = await getXCredentials(c.req.param("id"));
    const user = await verifyCredentials(accessToken);
    const { data, error } = await dbClient()
      .from("x_credential")
      .update({
        last_verified_at: new Date().toISOString(),
        x_username: user.username,
      })
      .eq("id", c.req.param("id"))
      .eq("store", STORE_NAME)
      .eq("x_user_id", user.id)
      .select("id")
      .maybeSingle();
    if (error || !data)
      throw new Error("認証アカウントが一致しません。再認証してください");
    return c.json({ verified: true, username: user.username });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "認証を確認できません" },
      400,
    );
  }
});
xCredentialRoutes.delete("/x/credentials/:id", async (c) => {
  const db = dbClient(),
    id = c.req.param("id"),
    lease = crypto.randomUUID();
  if (!uuid(id)) return c.json({ error: "アカウントが不正です" }, 400);
  const { data: locked, error } = await db.rpc("x_account_lease", {
    p_store: STORE_NAME,
    p_id: id,
    p_token: lease,
  });
  if (error || !locked)
    return c.json({ error: "アカウントが見つからないか、処理中です" }, 409);
  try {
    const { error: saveError } = await db
      .from("x_credential")
      .update({
        status: "revoked",
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        is_default: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("store", STORE_NAME)
      .eq("lease_token", lease);
    if (saveError) return c.json({ error: "接続を解除できませんでした" }, 500);
    return c.json({ success: true });
  } finally {
    await db.rpc("x_account_lease", {
      p_store: STORE_NAME,
      p_id: id,
      p_token: lease,
      p_release: true,
    });
  }
});
