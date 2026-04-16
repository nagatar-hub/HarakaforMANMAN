/**
 * Discord Webhook 通知
 *
 * ジョブの完了・失敗時にプッシュ通知を送信する。
 * 通知失敗時はジョブを中断せず、console.warn のみ出力する（fire-and-forget）。
 */

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const DISCORD_TIMEOUT_MS = 10_000;

export const COLOR = {
  SUCCESS: 0x00ff00, // 緑
  ERROR: 0xff0000, // 赤
  WARNING: 0xffaa00, // 黄
} as const;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordNotification {
  title: string;
  description: string;
  color: number;
  fields?: DiscordField[];
}

// ---------------------------------------------------------------------------
// Webhook URL 取得
// ---------------------------------------------------------------------------

let cachedWebhookUrl: string | null | undefined;

async function getWebhookUrl(): Promise<string | null> {
  if (cachedWebhookUrl !== undefined) return cachedWebhookUrl;

  // 環境変数優先
  if (process.env.DISCORD_WEBHOOK_URL) {
    cachedWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    return cachedWebhookUrl;
  }

  // Secret Manager フォールバック
  try {
    const { getSecret } = await import('./secret-manager.js');
    cachedWebhookUrl = await getSecret('discord-webhook-url');
    return cachedWebhookUrl;
  } catch {
    cachedWebhookUrl = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * Discord Webhook に通知を送信する。
 *
 * - DISCORD_WEBHOOK_URL 未設定時はスキップ（ログのみ）
 * - タイムアウト: 10秒
 * - 失敗時: console.warn のみ。ジョブは続行。
 */
export async function sendDiscordNotification(params: DiscordNotification): Promise<void> {
  const webhookUrl = await getWebhookUrl();

  if (!webhookUrl) {
    console.log(`[discord] Webhook URL 未設定、通知スキップ: ${params.title}`);
    return;
  }

  const payload = {
    embeds: [
      {
        title: params.title,
        description: params.description,
        color: params.color,
        fields: params.fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[discord] 通知送信失敗: HTTP ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[discord] 通知送信失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}
