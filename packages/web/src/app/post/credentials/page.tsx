"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  POSTING_KIND_LABELS,
  type PostingAccount,
  type PostingKind,
} from "@haraka/shared";
import {
  requestPosting,
  buttonClass,
  secondaryClass,
  inputClass,
  postingDate,
} from "../posting-client";

type Setup = { ready: boolean; missing: string[]; callback_url: string | null };
function AccountRow({
  account,
  onChange,
  onAuth,
  onError,
}: {
  account: PostingAccount;
  onChange: () => Promise<void>;
  onAuth: (kind: PostingKind, id?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(account.account_name);
  const [kind, setKind] = useState<PostingKind>(
    account.posting_kind || "store",
  );
  const [busy, setBusy] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [message, setMessage] = useState("");
  const act = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage("");
    onError("");
    try {
      await action();
      await onChange();
      setMessage(success);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setDisconnect(false);
    }
  };
  return (
    <article className="rounded-xl border border-border-card bg-white/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <a
            href={"https://x.com/" + account.x_username}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline-offset-4 hover:underline"
          >
            @{account.x_username}
          </a>
          <p className="mt-1 text-xs text-text-secondary">
            {account.status === "active"
              ? "接続済み"
              : account.status === "revoked"
                ? "接続解除済み"
                : "再認証が必要です"}
            {account.last_verified_at
              ? " · 最終確認 " + postingDate(account.last_verified_at)
              : ""}
          </p>
        </div>
        <span className="rounded-md bg-card-bg px-2 py-1 text-xs">
          {account.posting_kind
            ? POSTING_KIND_LABELS[account.posting_kind] + "用"
            : "用途が未設定"}
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto]">
        <label className="space-y-1 text-sm">
          <span>表示名</span>
          <input
            className={inputClass}
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>用途</span>
          <select
            className={inputClass}
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as PostingKind)}
          >
            <option value="store">店頭</option>
            <option value="postal">郵送</option>
          </select>
        </label>
        <button
          className={secondaryClass + " self-end"}
          disabled={
            busy ||
            !name.trim() ||
            (name === account.account_name && kind === account.posting_kind)
          }
          onClick={() =>
            void act(
              () =>
                requestPosting("/x/credentials/" + account.id, {
                  method: "PATCH",
                  body: JSON.stringify({
                    account_name: name,
                    posting_kind: kind,
                  }),
                }),
              "設定を保存しました",
            )
          }
        >
          設定を保存
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={secondaryClass}
          disabled={busy}
          onClick={() => void onAuth(account.posting_kind || kind, account.id)}
        >
          再認証
        </button>
        <button
          className={secondaryClass}
          disabled={busy || account.status !== "active"}
          onClick={() =>
            void act(
              () =>
                requestPosting("/x/credentials/" + account.id + "/verify", {
                  method: "POST",
                  body: "{}",
                }),
              "接続を確認しました",
            )
          }
        >
          接続を確認
        </button>
        {account.status !== "revoked" && (
          <button
            className={secondaryClass}
            disabled={busy}
            onClick={() => setDisconnect(true)}
          >
            接続を解除
          </button>
        )}
      </div>
      {disconnect && (
        <div className="mt-3 rounded-lg border border-border-card p-3 text-sm">
          <p>このアカウントでの投稿を停止します。投稿履歴は残ります。</p>
          <div className="mt-3 flex gap-2">
            <button
              className={secondaryClass}
              disabled={busy}
              onClick={() => setDisconnect(false)}
            >
              キャンセル
            </button>
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    requestPosting("/x/credentials/" + account.id, {
                      method: "DELETE",
                    }),
                  "接続を解除しました",
                )
              }
            >
              接続を解除する
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-green-800">
          {message}
        </p>
      )}
    </article>
  );
}
export default function CredentialsPage() {
  const [accounts, setAccounts] = useState<PostingAccount[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [kind, setKind] = useState<PostingKind>("store");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const reload = async () => {
    const [a, s] = await Promise.all([
      requestPosting<PostingAccount[]>("/x/credentials"),
      requestPosting<Setup>("/x/setup"),
    ]);
    setAccounts(a);
    setSetup(s);
  };
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("error")) setError(query.get("error")!);
    if (query.get("success"))
      setMessage("@" + query.get("success") + " を接続しました");
    if (query.size)
      window.history.replaceState(null, "", window.location.pathname);
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const authorize = async (purpose: PostingKind, id?: string) => {
    setBusy(true);
    setError("");
    try {
      const data = await requestPosting<{ url: string }>("/x/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({ kind: purpose, credential_id: id }),
      });
      window.location.assign(data.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-4xl pb-20">
      <Link
        href="/post"
        className="text-sm text-text-secondary hover:underline"
      >
        ← X投稿
      </Link>
      <h1 className="page-title mb-2 mt-3 text-2xl">Xアカウント管理</h1>
      <p className="mb-6 text-sm text-text-secondary">
        店頭・郵送それぞれのアカウントを登録できます。投稿ごとに送信先を選択します。
      </p>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}
      {message && (
        <div
          role="status"
          className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800"
        >
          {message}
        </div>
      )}
      {setup && !setup.ready && (
        <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold text-amber-950">初期設定が必要です</h2>
          <p className="mt-2 text-sm text-amber-950">
            管理者が次のサーバー設定を登録すると、Xアカウントを接続できます。
          </p>
          <ul className="mt-2 list-inside list-disc text-sm text-amber-950">
            {setup.missing.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="mb-6 rounded-xl border border-border-card bg-white/40 p-4">
        <h2 className="mb-3 font-semibold">アカウントを追加</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span>このアカウントの用途</span>
            <select
              className={inputClass}
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as PostingKind)}
            >
              <option value="store">店頭買取</option>
              <option value="postal">郵送買取</option>
            </select>
          </label>
          <button
            className={buttonClass}
            disabled={busy || !setup?.ready}
            onClick={() => void authorize(kind)}
          >
            {busy ? "Xを開いています…" : "Xアカウントを接続"}
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-text-secondary">
          Xの認証画面で、接続したいアカウントにログインしていることを確認してください。別のアカウントを追加するときは、X側のアカウントを切り替えてから接続します。
        </p>
      </section>
      {loading ? (
        <p role="status">読み込み中…</p>
      ) : (
        <div className="space-y-4">
          {accounts.map((a) => (
            <AccountRow
                key={a.id}
              account={a as PostingAccount}
              onChange={reload}
              onAuth={authorize}
              onError={setError}
            />
          ))}
          {!accounts.length && (
            <p className="text-sm text-text-secondary">
              登録済みのアカウントはありません。
            </p>
          )}
        </div>
      )}
      {setup?.callback_url && (
        <details className="mt-6 text-sm text-text-secondary">
          <summary className="cursor-pointer">管理者向けの接続情報</summary>
          <p className="mt-2">
            X Developer ConsoleのCallback URIには、次のURLを登録してください。
          </p>
          <code className="mt-2 block break-all rounded-lg bg-card-bg p-3">
            {setup.callback_url}
          </code>
        </details>
      )}
    </div>
  );
}
