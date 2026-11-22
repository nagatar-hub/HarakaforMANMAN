import twitterText from "twitter-text";

export type PostingKind = "store" | "postal";
export const POSTING_KIND_LABELS: Record<PostingKind, string> = {
  store: "店頭",
  postal: "郵送",
};
export const MAX_POST_IMAGES = 200;
export type PostingImage = {
  page_id: string;
  label: string;
  url: string;
  key: string;
};
export type PostingItem = {
  id: string;
  text: string;
  images: PostingImage[];
  status: "pending" | "preparing" | "posting" | "posted" | "failed" | "unknown";
  tweet_id?: string | null;
  error?: string | null;
};
export type PostingDocument = {
  version: 2;
  kind: PostingKind;
  account: { id: string; user_id: string; username: string; name: string };
  items: PostingItem[];
};
export type PostingPlan = {
  id: string;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
  lease_expires_at: string | null;
  thread_head_tweet_id: string | null;
  posting_data: PostingDocument;
};
export type PostingAccount = {
  id: string;
  account_name: string;
  x_user_id: string;
  x_username: string;
  status: string;
  posting_kind: PostingKind | null;
  token_expires_at: string | null;
  last_verified_at: string | null;
  updated_at?: string;
};
export function isPostingKind(value: unknown): value is PostingKind {
  return value === "store" || value === "postal";
}
export function postTextLength(text: string): number {
  if (text.length > 10_000) return text.length;
  return twitterText.parseTweet(text.normalize("NFC")).weightedLength;
}
export function validatePostText(
  text: unknown,
  hasImages = false,
): string | null {
  if (typeof text !== "string") return "投稿文を入力してください";
  if (text.length > 10_000) return "投稿文が長すぎます";
  if (!text.trim()) return hasImages ? null : "本文または画像が必要です";
  if (/\{\{[^}]+\}\}/u.test(text)) return "未入力のテンプレート変数があります";
  if (!twitterText.parseTweet(text.normalize("NFC")).valid)
    return "投稿文はXの通常投稿の上限（日本語は約140字）以内にしてください";
  return null;
}
