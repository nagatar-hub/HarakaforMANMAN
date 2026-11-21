"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useParams } from "next/navigation";
import {
  POSTING_KIND_LABELS,
  postTextLength,
  validatePostText,
  type PostingPlan,
} from "@haraka/shared";
import {
  requestPosting,
  planLabel,
  buttonClass,
  secondaryClass,
  inputClass,
} from "../posting-client";

const itemLabels: Record<string, string> = {
  pending: "未投稿",
  preparing: "画像を準備中",
  posting: "送信中",
  posted: "投稿済み",
  failed: "停止中",
  unknown: "結果を要確認",
};
export default function PlanPage() {
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PostingPlan | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [notPosted, setNotPosted] = useState(false);
  const [tweetUrl, setTweetUrl] = useState("");
  const [clock, setClock] = useState(Date.now());
  const continuePosting = useRef(false);
  const mounted = useRef(true);
  const confirmationDialog = useRef<HTMLElement>(null);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirmOpen) return;
    const dialog = confirmationDialog.current;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href]",
        ),
      ];
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      confirmationButton.current?.focus();
    };
  }, [confirmOpen]);
  const applyPlan = useCallback((next: PostingPlan) => {
    setPlan(next);
    setTexts(next.posting_data.items.map((i) => i.text));
    setNotPosted(false);
    setTweetUrl("");
  }, []);
  const reload = useCallback(async () => {
    const p = await requestPosting<PostingPlan>("/posting/plans/" + planId);
    if (mounted.current) applyPlan(p);
    return p;
  }, [planId, applyPlan]);
  useEffect(() => {
    mounted.current = true;
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      mounted.current = false;
      continuePosting.current = false;
    };
  }, [reload]);
  useEffect(() => {
    if (!plan?.lease_expires_at || running) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      reload().catch((e) => setError(e.message));
    }, 10_000);
    return () => clearInterval(timer);
  }, [plan?.lease_expires_at, running, reload]);
  const mutate = async (action: () => Promise<PostingPlan>) => {
    setBusy(true);
    setError("");
    try {
      applyPlan(await action());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startPosting = async () => {
    if (!plan || !confirmed) return;
    setConfirmOpen(false);
    setRunning(true);
    setError("");
    continuePosting.current = true;
    let current = plan;
    try {
      while (continuePosting.current) {
        current = await requestPosting<PostingPlan>(
          "/posting/plans/" + planId + "/step",
          {
            method: "POST",
            body: JSON.stringify({
              revision: current.revision,
              account_user_id: current.posting_data.account.user_id,
            }),
          },
        );
        if (!mounted.current) break;
        applyPlan(current);
        if (
          current.status === "completed" ||
          current.posting_data.items.some(
            (i) => i.status === "failed" || i.status === "unknown",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        try {
          await reload();
        } catch {
          /* Keep the last confirmed state visible. */
        }
      }
    } finally {
      continuePosting.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  if (loading)
    return (
      <p
        role="status"
        className="py-10 text-center text-sm text-text-secondary"
      >
        下書きを読み込み中…
      </p>
    );
  if (!plan)
    return (
      <div>
        <Link href="/post" className="underline">
          ← X投稿
        </Link>
        <p role="alert" className="mt-4">
          {error || "下書きが見つかりません"}
        </p>
      </div>
    );
  const doc = plan.posting_data;
  const dirty = texts.some((t, i) => t !== doc.items[i].text);
  const invalid = texts.some(
    (t, i) => !!validatePostText(t, doc.items[i].images.length > 0),
  );
  const hasUnknown = doc.items.some((i) => i.status === "unknown");
  const activeLease = !!plan.lease_expires_at;
  const expiredLease =
    activeLease && new Date(plan.lease_expires_at!).getTime() < clock;
  const locked = busy || running || activeLease || hasUnknown;
  const completed = doc.items.filter((i) => i.status === "posted").length;
  const imageCount = doc.items.reduce((sum, i) => sum + i.images.length, 0);
  const canStart = !locked && !dirty && !invalid && plan.status !== "completed";
  return (
    <div className="mx-auto max-w-4xl pb-28">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/post"
          className="text-sm text-text-secondary hover:underline"
        >
          ← 下書き・投稿履歴
        </Link>
        <button
          className={secondaryClass}
          disabled={running || busy || dirty}
          onClick={() => void reload().catch((e) => setError(e.message))}
        >
          結果を更新
        </button>
      </div>
      <div className="mb-5 rounded-xl border border-border-card bg-white/50 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-1 text-xs text-text-secondary">
              {POSTING_KIND_LABELS[doc.kind]}買取の投稿先
            </p>
            <h1 className="text-xl font-semibold">@{doc.account.username}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {doc.account.name}
            </p>
          </div>
          <div className="text-right">
            <p className="font-medium">{planLabel(plan)}</p>
            <p className="mt-1 text-sm text-text-secondary">
              {completed} / {doc.items.length}件 · {imageCount}枚
            </p>
          </div>
        </div>
        {plan.thread_head_tweet_id && (
          <a
            className="mt-4 inline-block text-sm underline"
            href={"https://x.com/i/status/" + plan.thread_head_tweet_id}
            target="_blank"
            rel="noopener noreferrer"
          >
            Xでスレッドを確認 ↗
          </a>
        )}
        <p className="mt-4 text-xs leading-relaxed text-text-secondary">
          下書きの画像と投稿先は保存済みです。元の買取表が更新されても、この内容は変わりません。
        </p>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}
      {running && (
        <div role="status" className="mb-4 rounded-lg bg-card-bg p-3 text-sm">
          投稿しています。この画面を開いたままお待ちください。
          <button
            className="ml-3 underline"
            onClick={() => {
              continuePosting.current = false;
              setError("現在の1件が終了したところで停止します。");
            }}
          >
            この1件で停止
          </button>
        </div>
      )}
      {!running && plan.status === "posting" && !activeLease && (
        <p className="mb-4 text-sm text-text-secondary">
          投稿を再開できます。投稿済みの内容は送信しません。
        </p>
      )}
      {expiredLease && !running && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p>
            処理が中断した可能性があります。送信状況を確認してから再開します。
          </p>
          <button
            disabled={busy}
            className={secondaryClass + " mt-3"}
            onClick={() =>
              void mutate(() =>
                requestPosting("/posting/plans/" + planId + "/recover", {
                  method: "POST",
                  body: JSON.stringify({ revision: plan.revision }),
                }),
              )
            }
          >
            中断した処理を確認する
          </button>
        </div>
      )}
      <ol className="space-y-5">
        {doc.items.map((item, index) => (
          <li
            key={item.id}
            className="rounded-xl border border-border-card bg-white/40 p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {index + 1}件目{index === 0 ? " · スレッドの先頭" : ""}
              </h2>
              <span
                className={`text-xs ${item.status === "posted" ? "text-green-800" : item.status === "failed" || item.status === "unknown" ? "text-red-700" : "text-text-secondary"}`}
              >
                {itemLabels[item.status] || item.status}
              </span>
            </div>
            {item.status === "posted" ? (
              <p className="mb-4 whitespace-pre-wrap text-sm">
                {item.text || "画像のみ"}
              </p>
            ) : (
              <label className="block">
                <span className="sr-only">{index + 1}件目の投稿文</span>
                <textarea
                  className={inputClass}
                  rows={Math.max(
                    2,
                    Math.min(7, (texts[index] || "").split("\n").length + 1),
                  )}
                  value={texts[index] ?? ""}
                  disabled={locked}
                  onChange={(e) =>
                    setTexts((prev) =>
                      prev.map((value, i) =>
                        i === index ? e.target.value : value,
                      ),
                    )
                  }
                />
                <span
                  className={`mt-1 block text-xs ${validatePostText(texts[index], item.images.length > 0) ? "text-red-700" : "text-text-secondary"}`}
                >
                  {postTextLength(texts[index] || "")} / 280
                  {validatePostText(texts[index], item.images.length > 0)
                    ? " · " +
                      validatePostText(texts[index], item.images.length > 0)
                    : ""}
                </span>
              </label>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {item.images.map((img, i) => (
                <a
                  key={img.key}
                  href={img.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-border-card bg-white p-1"
                >
                  <div className="relative aspect-[4/3]">
                    <Image
                      src={img.url}
                      alt={img.label}
                      fill
                      sizes="(max-width:640px) 45vw, 390px"
                      unoptimized
                      className="object-contain"
                    />
                  </div>
                  <p className="truncate px-2 py-1 text-xs text-text-secondary">
                    {i + 1}. {img.label} ↗
                  </p>
                </a>
              ))}
            </div>
            {item.error && (
              <p role="alert" className="mt-3 text-sm text-red-800">
                {item.error}
              </p>
            )}
            {item.tweet_id && (
              <a
                className="mt-3 inline-block text-sm underline"
                href={"https://x.com/i/status/" + item.tweet_id}
                target="_blank"
                rel="noopener noreferrer"
              >
                この投稿を見る ↗
              </a>
            )}
          </li>
        ))}
      </ol>
      {hasUnknown && !activeLease && (
        <section className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">X上の投稿結果を確認してください</h2>
          <p className="mt-2 text-sm leading-relaxed">
            結果が不明なため、再送を止めています。@{doc.account.username}{" "}
            を開き、確認待ちの投稿があるか確認してください。
          </p>
          <a
            className="mt-2 inline-block text-sm underline"
            href={"https://x.com/" + doc.account.username}
            target="_blank"
            rel="noopener noreferrer"
          >
            アカウントを開く ↗
          </a>
          <label className="mt-4 block space-y-2 text-sm">
            <span>投稿がある場合：その投稿のURL</span>
            <input
              className={inputClass}
              type="url"
              placeholder="https://x.com/…/status/…"
              value={tweetUrl}
              onChange={(e) => setTweetUrl(e.target.value)}
            />
          </label>
          <button
            className={secondaryClass + " mt-2"}
            disabled={busy || !tweetUrl}
            onClick={() =>
              void mutate(() =>
                requestPosting("/posting/plans/" + planId + "/resolve", {
                  method: "POST",
                  body: JSON.stringify({
                    revision: plan.revision,
                    tweet_url: tweetUrl,
                  }),
                }),
              )
            }
          >
            投稿URLを照合して結果を保存
          </button>
          <div className="mt-4 border-t border-amber-300 pt-4">
            <label className="flex items-start gap-2 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={notPosted}
                onChange={(e) => setNotPosted(e.target.checked)}
              />
              <span>Xを確認し、この投稿が存在しないことを確認しました</span>
            </label>
            <button
              className={secondaryClass + " mt-3"}
              disabled={busy || !notPosted}
              onClick={() =>
                void mutate(() =>
                  requestPosting("/posting/plans/" + planId + "/resolve", {
                    method: "POST",
                    body: JSON.stringify({
                      revision: plan.revision,
                      confirm_not_posted: true,
                    }),
                  }),
                )
              }
            >
              未投稿として記録
            </button>
          </div>
        </section>
      )}
      <div
        className={`${plan.status === "completed" ? "" : "sticky bottom-28 "}mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-card bg-page-bg/95 p-4 shadow-sm backdrop-blur-sm`}
      >
        <div>
          <p className="text-sm font-semibold">
            @{doc.account.username} · {POSTING_KIND_LABELS[doc.kind]}
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {dirty
              ? "文章に未保存の変更があります"
              : plan.status === "completed"
                ? "すべての投稿結果を保存しました"
                : "内容と投稿先を確認してから送信してください"}
          </p>
        </div>
        <div className="flex gap-2">
          {dirty && (
            <button
              className={secondaryClass}
              disabled={locked || invalid}
              onClick={() =>
                void mutate(() =>
                  requestPosting("/posting/plans/" + planId, {
                    method: "PATCH",
                    body: JSON.stringify({ revision: plan.revision, texts }),
                  }),
                )
              }
            >
              文章を保存
            </button>
          )}
          {plan.status !== "completed" && (
            <button
              ref={confirmationButton}
              className={buttonClass}
              disabled={!canStart}
              onClick={() => {
                setConfirmed(false);
                setConfirmOpen(true);
              }}
            >
              {completed ? "投稿を再開する" : "投稿内容を最終確認"}
            </button>
          )}
        </div>
      </div>
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => setConfirmOpen(false)}
        >
          <section
            ref={confirmationDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="post-confirm-title"
            className="w-full max-w-md rounded-2xl bg-page-bg p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmOpen(false);
            }}
          >
            <h2 id="post-confirm-title" className="text-lg font-semibold">
              このアカウントに投稿します
            </h2>
            <p className="mt-4 text-xl font-semibold">
              @{doc.account.username}
            </p>
            <p className="mt-1 text-sm">
              {doc.account.name} · {POSTING_KIND_LABELS[doc.kind]}買取
            </p>
            <p className="mt-3 text-sm text-text-secondary">
              未投稿の{doc.items.length - completed}件を順番に送信します。
            </p>
            <label className="mt-5 flex items-center gap-2 text-sm">
              <input
                autoFocus
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              投稿先・文章・画像を確認しました
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className={secondaryClass}
                onClick={() => setConfirmOpen(false)}
              >
                戻る
              </button>
              <button
                className={buttonClass}
                disabled={!confirmed}
                onClick={() => void startPosting()}
              >
                Xに投稿する
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
