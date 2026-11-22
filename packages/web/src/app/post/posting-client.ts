import type { PostingPlan } from "@haraka/shared";
export const postingApi = "/api/posting";
export async function requestPosting<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(postingApi + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "読み込みに失敗しました");
  return data;
}
export function postingDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function planLabel(p: PostingPlan) {
  if (p.status === "completed") return "投稿完了";
  if (p.posting_data.items.some((i) => i.status === "unknown"))
    return "結果の確認が必要";
  if (p.lease_expires_at) return "投稿処理中";
  if (p.posting_data.items.some((i) => i.status === "failed")) return "停止中";
  if (p.status === "posting" || p.status === "partial")
    return "途中まで投稿済み";
  return "下書き";
}
export const buttonClass =
  "rounded-lg bg-text-primary px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 active:scale-[.98] transition-transform";
export const secondaryClass =
  "rounded-lg border border-border-card px-3 py-2 text-sm disabled:opacity-40 hover:bg-card-bg";
export const inputClass =
  "w-full rounded-lg border border-border-card bg-white/70 px-3 py-2.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-text-primary/30";
