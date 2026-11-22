import crypto from "node:crypto";
import { createSupabaseClient } from "./supabase.js";
import { STORE_NAME } from "./store-scope.js";
import type { PostingKind } from "@haraka/shared";

const SCOPES = "tweet.read tweet.write users.read offline.access media.write";
export function xSetupStatus() {
  const required = [
    "X_CLIENT_ID",
    "X_CLIENT_SECRET",
    "X_OAUTH_CALLBACK_URL",
    "X_TOKEN_ENCRYPTION_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (
    process.env.X_TOKEN_ENCRYPTION_KEY &&
    Buffer.from(process.env.X_TOKEN_ENCRYPTION_KEY, "base64").length !== 32
  )
    missing.push("X_TOKEN_ENCRYPTION_KEY（32バイトのBase64）");
  const callback = process.env.X_OAUTH_CALLBACK_URL;
  if (callback) {
    try {
      const url = new URL(callback);
      if (
        url.pathname !== "/api/posting/x/oauth/callback" ||
        (url.protocol !== "https:" && url.hostname !== "localhost")
      )
        missing.push("X_OAUTH_CALLBACK_URL（コールバックURLが不正です）");
    } catch {
      missing.push("X_OAUTH_CALLBACK_URL（URLが不正です）");
    }
  }
  return {
    ready: missing.length === 0,
    missing,
    callback_url: callback || null,
  };
}
function encryptionKey() {
  const key = Buffer.from(process.env.X_TOKEN_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32) throw new Error("Xの暗号化キーが未設定です");
  return key;
}
export function sealXSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return (
    "enc:v1:" +
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
  );
}
export function openXSecret(value: string): string {
  if (!value.startsWith("enc:v1:")) return value; // Existing credentials migrate on re-authentication/refresh.
  const bytes = Buffer.from(value.slice(7), "base64");
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
export function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}
export function generateCodeChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
export async function buildAuthorizationUrl(
  operatorEmail: string,
  kind: PostingKind,
  expectedUserId?: string,
) {
  if (!xSetupStatus().ready)
    throw new Error("X連携の本番設定が完了していません");
  const db = createSupabaseClient() as any;
  const state = crypto.randomUUID();
  const verifier = generateCodeVerifier();
  const { error } = await db
    .from("x_oauth_request")
    .insert({
      state,
      store: STORE_NAME,
      verifier_ciphertext: sealXSecret(verifier),
      operator_email: operatorEmail,
      posting_kind: kind,
      expected_user_id: expectedUserId || null,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
  if (error) throw new Error("X認証の開始情報を保存できませんでした");
  await db
    .from("x_oauth_request")
    .delete()
    .eq("store", STORE_NAME)
    .lt("expires_at", new Date().toISOString());
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID!,
    redirect_uri: process.env.X_OAUTH_CALLBACK_URL!,
    scope: SCOPES,
    state,
    code_challenge: generateCodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  return { url: `https://x.com/i/oauth2/authorize?${params}`, state };
}
export async function getVerifierForState(
  state: string,
  operatorEmail: string,
) {
  const { data, error } = await (createSupabaseClient() as any)
    .from("x_oauth_request")
    .delete()
    .eq("state", state)
    .eq("store", STORE_NAME)
    .eq("operator_email", operatorEmail)
    .gt("expires_at", new Date().toISOString())
    .select()
    .maybeSingle();
  if (error || !data)
    throw new Error("X認証の有効期限が切れました。もう一度認証してください");
  return {
    verifier: openXSecret(data.verifier_ciphertext),
    kind: data.posting_kind as PostingKind,
    expectedUserId: data.expected_user_id as string | null,
  };
}
async function requestTokens(body: URLSearchParams) {
  let res: Response;
  try {
    res = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64")}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Xの認証サーバーに接続できませんでした");
  }
  if (!res.ok)
    throw new Error(
      `X認証を更新できませんでした（${res.status}）。再認証してください`,
    );
  const result = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!result.access_token || !result.refresh_token || !(result.expires_in > 0))
    throw new Error("X認証の応答が不正です。再認証してください");
  return result;
}
export function exchangeCodeForTokens(code: string, verifier: string) {
  return requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.X_OAUTH_CALLBACK_URL!,
      client_id: process.env.X_CLIENT_ID!,
      code_verifier: verifier,
    }),
  );
}
export function refreshAccessToken(refreshToken: string) {
  return requestTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.X_CLIENT_ID!,
    }),
  );
}
export async function getXCredentials(
  credentialId: string,
  heldLease?: string,
): Promise<{ accessToken: string }> {
  const db = createSupabaseClient() as any;
  const lease = heldLease || crypto.randomUUID();
  if (!heldLease) {
    const { data, error } = await db.rpc("x_account_lease", {
      p_store: STORE_NAME,
      p_id: credentialId,
      p_token: lease,
    });
    if (error || !data)
      throw new Error("このXアカウントは処理中です。しばらくお待ちください");
  }
  try {
    const { data: row, error } = await db
      .from("x_credential")
      .select("*")
      .eq("id", credentialId)
      .eq("store", STORE_NAME)
      .eq("lease_token", lease)
      .gt("lease_expires_at", new Date().toISOString())
      .maybeSingle();
    if (
      error ||
      !row ||
      row.status !== "active" ||
      !row.access_token ||
      !row.refresh_token
    )
      throw new Error("Xアカウントを再認証してください");
    if (new Date(row.token_expires_at || 0).getTime() - Date.now() < 600_000) {
      const tokens = await refreshAccessToken(openXSecret(row.refresh_token));
      const { data: saved, error: saveError } = await db
        .from("x_credential")
        .update({
          access_token: sealXSecret(tokens.access_token),
          refresh_token: sealXSecret(tokens.refresh_token),
          token_expires_at: new Date(
            Date.now() + tokens.expires_in * 1000,
          ).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", credentialId)
        .eq("store", STORE_NAME)
        .eq("lease_token", lease)
        .select("id")
        .maybeSingle();
      if (saveError || !saved)
        throw new Error(
          "更新したX認証を保存できませんでした。再認証してください",
        );
      return { accessToken: tokens.access_token };
    }
    return { accessToken: openXSecret(row.access_token) };
  } finally {
    if (!heldLease)
      await db.rpc("x_account_lease", {
        p_store: STORE_NAME,
        p_id: credentialId,
        p_token: lease,
        p_release: true,
      });
  }
}
export async function getDefaultXCredentials(): Promise<{
  id: string;
  accessToken: string;
}> {
  throw new Error("投稿先アカウントを明示的に選択してください");
}
