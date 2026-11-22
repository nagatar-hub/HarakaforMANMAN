export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly ambiguous = false,
  ) {
    super(message);
  }
}
async function xRequest(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  createsPost = false,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`https://api.x.com/2/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new XApiError(
      createsPost
        ? "Xから送信結果を受信できませんでした"
        : "Xに接続できませんでした",
      0,
      createsPost,
    );
  }
  if (!res.ok) {
    const messages: Record<number, string> = {
      400: "Xが投稿内容を受け付けませんでした。本文・画像を確認してください",
      401: "Xの認証が失効しました。アカウントを再認証してください",
      402: "X APIの利用枠・クレジットを確認してください",
      403: "Xの投稿権限・利用設定を確認してください",
      429: "Xの利用制限に達しました。時間をおいて再開してください",
    };
    throw new XApiError(
      messages[res.status] ||
        `Xへの接続でエラーが発生しました（${res.status}）`,
      res.status,
      createsPost && res.status >= 500,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new XApiError(
      "Xの応答を確認できませんでした",
      res.status,
      createsPost,
    );
  }
}
export async function verifyCredentials(
  accessToken: string,
): Promise<{ id: string; username: string; name: string }> {
  const json = await xRequest(
    "users/me?user.fields=username,name",
    accessToken,
  );
  if (!json.data?.id || !json.data?.username)
    throw new XApiError("Xアカウントを確認できませんでした", 200);
  return json.data;
}
export async function uploadMedia(
  accessToken: string,
  imageBuffer: Buffer,
  mimeType = "image/png",
): Promise<string> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
    imageBuffer.length > 5 * 1024 * 1024
  ) {
    throw new Error("画像は5MB以下のPNG・JPEG・WebPにしてください");
  }
  const form = new FormData();
  form.append(
    "media",
    new Blob([new Uint8Array(imageBuffer)], { type: mimeType }),
    "buylist",
  );
  form.append("media_category", "tweet_image");
  const json = await xRequest("media/upload", accessToken, {
    method: "POST",
    body: form,
  });
  if (!json.data?.id)
    throw new XApiError("画像のアップロード結果を確認できませんでした", 200);
  return String(json.data.id);
}
export async function postTweet(
  accessToken: string,
  params: { text: string; media_ids?: string[]; reply_to?: string },
): Promise<{ id: string; text: string }> {
  const body: Record<string, unknown> = {};
  if (params.text.trim()) body.text = params.text.normalize("NFC");
  if (params.media_ids?.length) body.media = { media_ids: params.media_ids };
  if (params.reply_to) body.reply = { in_reply_to_tweet_id: params.reply_to };
  const json = await xRequest(
    "tweets",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    true,
  );
  if (!/^\d+$/.test(json.data?.id ?? ""))
    throw new XApiError("投稿IDを確認できませんでした", 200, true);
  return json.data;
}
export async function lookupTweet(accessToken: string, id: string) {
  const json = await xRequest(
    `tweets/${id}?tweet.fields=author_id,referenced_tweets,attachments,entities`,
    accessToken,
  );
  if (!json.data) throw new Error("投稿が見つかりません");
  return json.data as {
    id: string;
    author_id: string;
    text: string;
    referenced_tweets?: { type: string; id: string }[];
    attachments?: { media_keys: string[] };
    entities?: { urls?: { url: string; expanded_url: string }[] };
  };
}
