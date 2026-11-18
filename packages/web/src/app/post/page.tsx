"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  MAX_POST_IMAGES,
  POSTING_KIND_LABELS,
  postTextLength,
  validatePostText,
  type PostingAccount,
  type PostingKind,
  type PostingPlan,
} from "@haraka/shared";
import {
  requestPosting,
  postingDate,
  planLabel,
  buttonClass,
  secondaryClass,
  inputClass,
} from "./posting-client";

type SourceImage = {
  id: string;
  franchise: string;
  page_label: string | null;
  display_name: string | null;
  image_url: string;
  page_index: number;
};
type SourceRun = { id: string; started_at: string };
type Template = { id: string; name: string; header_template: string };
type Setup = { ready: boolean; missing: string[]; store: string };

export default function PostPage() {
  const router = useRouter();
  const [kind, setKind] = useState<PostingKind>("store");
  const [accounts, setAccounts] = useState<PostingAccount[]>([]);
  const [plans, setPlans] = useState<PostingPlan[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<SourceRun[]>([]);
  const [runId, setRunId] = useState("");
  const [images, setImages] = useState<SourceImage[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [franchise, setFranchise] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const submissionId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      requestPosting<PostingAccount[]>("/x/credentials"),
      requestPosting<PostingPlan[]>("/posting/plans"),
      requestPosting<Setup>("/x/setup"),
      requestPosting<Template[]>("/post/templates"),
    ])
      .then(([a, p, s, t]) => {
        if (!cancelled) {
          setAccounts(a);
          setPlans(p);
          setSetup(s);
          setTemplates(t);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setRuns([]);
    setRunId("");
    setImages([]);
    setSelected([]);
    setFranchise("");
    setAccountId("");
    submissionId.current = null;
    setText(
      new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
      }).format(new Date()) +
        " " +
        POSTING_KIND_LABELS[kind] +
        "買取表",
    );
    requestPosting<SourceRun[]>("/posting/runs?kind=" + kind, {
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setRuns(rows);
          setRunId(rows[0]?.id || "");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [kind]);
  useEffect(() => {
    const controller = new AbortController();
    setImages([]);
    setSelected([]);
    setFranchise("");
    submissionId.current = null;
    if (!runId) {
      setImagesLoading(false);
      return () => controller.abort();
    }
    setImagesLoading(true);
    requestPosting<SourceImage[]>(
      `/posting/images?kind=${kind}&run_id=${runId}`,
      { signal: controller.signal },
    )
      .then((rows) => {
        if (!controller.signal.aborted) setImages(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setImagesLoading(false);
      });
    return () => controller.abort();
  }, [kind, runId]);

  const availableAccounts = accounts.filter(
    (a) => a.posting_kind === kind && a.status === "active",
  );
  const visibleImages = images.filter(
    (i) => !franchise || i.franchise === franchise,
  );
  const selectedImages = selected
    .map((id) => images.find((i) => i.id === id)!)
    .filter(Boolean);
  const textError = validatePostText(text, true);
  const changeSelection = (next: string[]) => {
    setSelected(next);
    submissionId.current = null;
  };
  const toggleImage = (id: string) =>
    changeSelection(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : selected.length < MAX_POST_IMAGES
          ? [...selected, id]
          : selected,
    );
  const move = (index: number, direction: number) => {
    const next = [...selected],
      target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    changeSelection(next);
  };
  const applyTemplate = async (id: string) => {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    try {
      const vars =
        await requestPosting<{ key: string; default_value: string | null }[]>(
          "/post/variables",
        );
      const now = new Date();
      const values: Record<string, string> = Object.fromEntries(
        vars
          .filter((v) => v.default_value !== null)
          .map((v) => [v.key, v.default_value!]),
      );
      Object.assign(values, {
        date: new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now),
        date_short: new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          month: "2-digit",
          day: "2-digit",
        }).format(now),
        weekday: new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          weekday: "short",
        }).format(now),
        franchise: franchise || "買取",
        franchise_en: franchise,
        page_count: String(selected.length),
      });
      setText(
        template.header_template.replace(
          /\{\{(\w+)\}\}/g,
          (match, key) => values[key] ?? match,
        ),
      );
      submissionId.current = null;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const createDraft = async () => {
    setSaving(true);
    setError("");
    submissionId.current ??= crypto.randomUUID();
    try {
      const plan = await requestPosting<PostingPlan>("/posting/plans", {
        method: "POST",
        body: JSON.stringify({
          id: submissionId.current,
          run_id: runId,
          kind,
          credential_id: accountId,
          page_ids: selected,
          text,
        }),
      });
      router.push("/post/" + plan.id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl pb-28">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl">X投稿</h1>
          <p className="mt-1 text-sm text-text-secondary">
            画像を選び、下書きを確認してから投稿します。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className={secondaryClass} href="/post/credentials">
            アカウント管理
          </Link>
          <Link className={secondaryClass} href="/post/templates">
            テンプレート
          </Link>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}
      {setup && !setup.ready && (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          X連携の初期設定が必要です。
          <Link href="/post/credentials" className="ml-2 underline">
            設定状況を確認
          </Link>
        </div>
      )}
      <section
        aria-labelledby="new-post-heading"
        className="rounded-xl border border-border-card bg-white/40 p-4 sm:p-5"
      >
        <h2 id="new-post-heading" className="mb-4 font-semibold">
          新しい投稿
        </h2>
        <div
          className="mb-4 flex flex-wrap gap-2"
          role="group"
          aria-label="買取の用途"
        >
          {(["store", "postal"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              disabled={saving}
              onClick={() => {
                setKind(k);
                setError("");
              }}
              className={kind === k ? buttonClass : secondaryClass}
            >
              {POSTING_KIND_LABELS[k]}買取
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>投稿先アカウント</span>
            <select
              className={inputClass}
              value={accountId}
              disabled={saving || loading}
              onChange={(e) => {
                setAccountId(e.target.value);
                submissionId.current = null;
              }}
            >
              <option value="">アカウントを選択</option>
              {availableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.x_username} · {a.account_name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>買取表の作成日時</span>
            <select
              className={inputClass}
              value={runId}
              disabled={saving}
              onChange={(e) => setRunId(e.target.value)}
            >
              {!runs.length && (
                <option value="">選択できる買取表がありません</option>
              )}
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {postingDate(r.started_at)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>商材で絞り込み</span>
            <select
              className={inputClass}
              value={franchise}
              disabled={saving}
              onChange={(e) => setFranchise(e.target.value)}
            >
              <option value="">すべて</option>
              {[...new Set(images.map((i) => i.franchise))].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        </div>
        {!loading && !availableAccounts.length && (
          <p className="mt-3 text-sm text-text-secondary">
            {POSTING_KIND_LABELS[kind]}
            用のアカウントが未登録、または再認証が必要です。
            <Link className="ml-1 underline" href="/post/credentials">
              アカウント管理へ
            </Link>
          </p>
        )}
        <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            投稿する画像{" "}
            <span className="ml-2 font-normal text-text-secondary">
              {selected.length}枚選択
            </span>
          </h3>
          <div className="flex gap-2">
            <button
              className={secondaryClass}
              disabled={saving || !visibleImages.length}
              onClick={() =>
                changeSelection(
                  [
                    ...new Set([
                      ...selected,
                      ...visibleImages.map((i) => i.id),
                    ]),
                  ].slice(0, MAX_POST_IMAGES),
                )
              }
            >
              表示中をすべて選択
            </button>
            <button
              className={secondaryClass}
              disabled={saving || !selected.length}
              onClick={() => changeSelection([])}
            >
              選択を解除
            </button>
          </div>
        </div>
        {imagesLoading ? (
          <p
            role="status"
            className="py-10 text-center text-sm text-text-secondary"
          >
            画像を読み込み中…
          </p>
        ) : !images.length ? (
          <p className="py-10 text-center text-sm text-text-secondary">
            この用途の作成済み画像がありません。
          </p>
        ) : (
          <div className="grid max-h-[520px] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3 lg:grid-cols-5">
            {visibleImages.map((img) => {
              const index = selected.indexOf(img.id);
              return (
                <button
                  key={img.id}
                  type="button"
                  disabled={saving}
                  aria-pressed={index >= 0}
                  onClick={() => toggleImage(img.id)}
                  className={`relative overflow-hidden rounded-lg border-2 text-left focus-visible:outline focus-visible:outline-2 ${index >= 0 ? "border-text-primary bg-white" : "border-transparent bg-white/50"}`}
                >
                  <div className="relative aspect-[4/3]">
                    <Image
                      src={img.image_url}
                      alt={img.display_name || img.page_label || img.franchise}
                      fill
                      sizes="(max-width:640px) 45vw, 220px"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                  <div className="px-2 py-2 text-xs">
                    <span className="block truncate font-medium">
                      {img.display_name || img.page_label || img.franchise}
                    </span>
                    <span className="text-text-secondary">
                      {img.franchise} · {img.page_index + 1}ページ
                    </span>
                  </div>
                  <span
                    className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border text-xs ${index >= 0 ? "border-text-primary bg-text-primary text-white" : "border-border-card bg-white"}`}
                  >
                    {index >= 0 ? index + 1 : ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selected.length > 0 && (
          <div className="mt-5 border-t border-border-card pt-4">
            <h3 className="text-sm font-semibold">
              投稿順{" "}
              <span className="ml-2 font-normal text-text-secondary">
                4枚ずつまとめます · 最大{MAX_POST_IMAGES}枚
              </span>
            </h3>
            <ol className="mt-2 flex gap-2 overflow-x-auto pb-2">
              {selectedImages.map((img, i) => (
                <li
                  key={img.id}
                  className="w-36 shrink-0 rounded-lg border border-border-card bg-white/50 p-2"
                >
                  <p className="truncate text-xs">
                    {i + 1}.{" "}
                    {img.display_name || img.page_label || img.franchise}
                  </p>
                  <div className="mt-2 flex justify-between gap-1">
                    <button
                      disabled={saving || i === 0}
                      className="px-2 py-1 text-sm disabled:opacity-30"
                      aria-label={`${i + 1}番の画像を前へ`}
                      onClick={() => move(i, -1)}
                    >
                      ←
                    </button>
                    <button
                      disabled={saving}
                      className="px-2 py-1 text-xs"
                      aria-label={`${i + 1}番の画像を除外`}
                      onClick={() => toggleImage(img.id)}
                    >
                      除外
                    </button>
                    <button
                      disabled={saving || i === selected.length - 1}
                      className="px-2 py-1 text-sm disabled:opacity-30"
                      aria-label={`${i + 1}番の画像を後へ`}
                      onClick={() => move(i, 1)}
                    >
                      →
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_240px]">
          <label className="text-sm">
            <span className="mb-2 block">最初の投稿文</span>
            <textarea
              rows={4}
              className={inputClass}
              value={text}
              disabled={saving}
              onChange={(e) => {
                setText(e.target.value);
                submissionId.current = null;
              }}
            />
            <span
              className={textError ? "text-red-700" : "text-text-secondary"}
            >
              {postTextLength(text)} / 280 {textError ? " · " + textError : ""}
            </span>
          </label>
          <div className="space-y-3">
            <label className="block space-y-2 text-sm">
              <span>テンプレートから入力</span>
              <select
                className={inputClass}
                defaultValue=""
                disabled={saving}
                onChange={(e) => void applyTemplate(e.target.value)}
              >
                <option value="">選択してください</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs leading-relaxed text-text-secondary">
              次の画面で、各投稿の文章と画像を確認できます。下書きを作成してもXには送信されません。
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-card pt-4">
          <p className="text-sm">
            {selected.length}枚 · {Math.ceil(selected.length / 4)}件のスレッド
          </p>
          <button
            className={buttonClass}
            disabled={
              saving ||
              loading ||
              imagesLoading ||
              !selected.length ||
              !accountId ||
              !!textError
            }
            onClick={() => void createDraft()}
          >
            {saving ? "下書きを保存中…" : "下書きを確認する →"}
          </button>
        </div>
      </section>
      <section className="mt-8" aria-labelledby="history-heading">
        <h2 id="history-heading" className="mb-3 font-semibold">
          下書き・投稿履歴
        </h2>
        {loading ? (
          <p className="text-sm text-text-secondary">読み込み中…</p>
        ) : !plans.length ? (
          <p className="text-sm text-text-secondary">まだ投稿はありません。</p>
        ) : (
          <div className="divide-y divide-border-card rounded-xl border border-border-card bg-white/30">
            {plans.map((p) => (
              <Link
                key={p.id}
                href={"/post/" + p.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 hover:bg-white/60"
              >
                <div>
                  <p className="text-sm font-medium">
                    @{p.posting_data.account.username}{" "}
                    <span className="ml-2 text-text-secondary">
                      {POSTING_KIND_LABELS[p.posting_data.kind]}買取
                    </span>
                  </p>
                  <p className="mt-1 max-w-xl truncate text-xs text-text-secondary">
                    {p.posting_data.items[0]?.text || "画像のみの投稿"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm">{planLabel(p)}</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {postingDate(p.created_at)} ·{" "}
                    {
                      p.posting_data.items.filter((i) => i.status === "posted")
                        .length
                    }
                    /{p.posting_data.items.length}件
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
