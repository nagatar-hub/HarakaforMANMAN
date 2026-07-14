/**
 * Haraka DB スプレッドシートへのタグ書き戻し
 *
 * タグ管理画面でタグを設定した際、「DB」タブに行を追加する。
 * 次回Sync時にlookupでマッチするようになる。
 *
 * DBタブのカラム配置:
 *   A: タイトル (franchise)
 *   B: タグ (tag/GROUP)
 *   C: ガチャ選択肢名称 (card_name)
 *   D: 種別 (grade)
 *   E: list_no
 *   F: 画像 (image_url)
 *   G: 代替画像URL
 *   H: レアリティ
 */

import { fetchWithRetry } from './fetch-with-retry.js';
import { getSecret } from './secret-manager.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getHarakaDbSpreadsheetId(): Promise<string | null> {
  if (process.env.HARAKA_DB_SPREADSHEET_ID) {
    return process.env.HARAKA_DB_SPREADSHEET_ID;
  }
  try {
    return await getSecret('haraka-db-spreadsheet-id');
  } catch {
    return null;
  }
}

async function resolveCredential(envName: string, secretName: string): Promise<string | null> {
  if (process.env[envName]) return process.env[envName] as string;
  try {
    return await getSecret(secretName);
  } catch {
    return null;
  }
}

async function getAccessToken(): Promise<string> {
  // env 未設定時は Secret Manager にフォールバック（Cloud Run に Secret 注入漏れがあっても動かすため）
  const [refreshToken, clientId, clientSecret] = await Promise.all([
    resolveCredential('GOOGLE_REFRESH_TOKEN', 'haraka-oauth-refresh-token'),
    resolveCredential('GOOGLE_CLIENT_ID', 'haraka-oauth-client-id'),
    resolveCredential('GOOGLE_CLIENT_SECRET', 'haraka-oauth-client-secret'),
  ]);

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const response = await fetchWithRetry(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    { maxRetries: 3, timeoutMs: 15_000 },
  );

  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(`Access token取得失敗: ${data.error}`);
  }

  const data = await response.json() as { access_token: string };
  return data.access_token;
}

export async function fetchHarakaDbSheetRows(): Promise<string[][]> {
  const spreadsheetId = await getHarakaDbSpreadsheetId();
  if (!spreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID not configured');

  const accessToken = await getAccessToken();
  const range = encodeURIComponent('DB');
  const response = await fetchWithRetry(
    `${GOOGLE_SHEETS_API_BASE}/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    },
    { maxRetries: 2, timeoutMs: 20_000 },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Haraka DB取得失敗: ${response.status} ${detail.slice(0, 300)}`);
  }

  const payload = await response.json() as { values?: unknown[][] };
  return (payload.values ?? []).map((row) =>
    row.map((value) => value === null || value === undefined ? '' : String(value)),
  );
}

/**
 * Haraka DB の「DB」タブにタグ行を追加する。
 *
 * @param card - タグを設定するカードの情報
 * @param tag  - 設定するタグ（= B列の値）
 */
export async function appendTagToHarakaDB(card: {
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  image_url: string | null;
}, tag: string): Promise<void> {
  const spreadsheetId = await getHarakaDbSpreadsheetId();
  if (!spreadsheetId) {
    console.warn('HARAKA_DB_SPREADSHEET_ID not set, skipping sheet write-back');
    return;
  }

  const accessToken = await getAccessToken();

  // 書き込み先は「DB」タブ
  const range = 'DB!A:H';

  // A:タイトル, B:タグ, C:ガチャ選択肢名称, D:種別, E:list_no, F:画像, G:代替画像URL, H:レアリティ
  const row = [
    card.franchise,       // A: タイトル
    tag,                  // B: タグ
    card.card_name,       // C: ガチャ選択肢名称
    card.grade || '',     // D: 種別
    card.list_no || '',   // E: list_no
    card.image_url || '', // F: 画像
    '',                   // G: 代替画像URL
    '',                   // H: レアリティ
  ];

  const encodedRange = encodeURIComponent(range);
  const url = `${GOOGLE_SHEETS_API_BASE}/${spreadsheetId}/values/${encodedRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values: [row],
      }),
    },
    { maxRetries: 3, timeoutMs: 30_000 },
  );

  if (!response.ok) {
    const data = await response.json() as { error?: { message?: string } };
    throw new Error(`シート書き込み失敗 (${response.status}): ${data.error?.message || 'unknown'}`);
  }

  console.log(`[sheet] DBタブに書き戻し完了: ${card.franchise} / ${card.card_name} → ${tag}`);
}

/**
 * DB列番号（1-indexed）→ A1表記の列文字
 */
function colNumberToLetter(colNum: number): string {
  return String.fromCharCode(64 + colNum); // 1→A, 2→B, ...
}

/**
 * DBタブ フィールド名 → DB_COLS の列番号マッピング
 */
const FIELD_TO_COL: Record<string, number> = {
  tag: 2,           // B列（GROUP）
  card_name: 3,     // C列（ガチャ選択肢名称）
  alt_image_url: 7, // G列（ALT_IMAGE）
};

/**
 * Haraka DB の「DB」タブの特定セルを更新する。
 *
 * @param sheetRowNumber - シートの行番号（1-indexed、ヘッダ=1）
 * @param field          - 更新するフィールド名（'tag' | 'alt_image_url'）
 * @param value          - 新しい値
 */
export async function updateDbSheetCell(
  sheetRowNumber: number,
  field: string,
  value: string,
): Promise<void> {
  const spreadsheetId = await getHarakaDbSpreadsheetId();
  if (!spreadsheetId) {
    console.warn('HARAKA_DB_SPREADSHEET_ID not set, skipping sheet cell update');
    return;
  }

  const colNum = FIELD_TO_COL[field];
  if (!colNum) {
    throw new Error(`Unknown field for sheet update: ${field}`);
  }

  const accessToken = await getAccessToken();
  const colLetter = colNumberToLetter(colNum);
  const cellRange = `DB!${colLetter}${sheetRowNumber}`;

  const encodedRange = encodeURIComponent(cellRange);
  const url = `${GOOGLE_SHEETS_API_BASE}/${spreadsheetId}/values/${encodedRange}?valueInputOption=RAW`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: cellRange,
        majorDimension: 'ROWS',
        values: [[value]],
      }),
    },
    { maxRetries: 3, timeoutMs: 30_000 },
  );

  if (!response.ok) {
    const data = await response.json() as { error?: { message?: string } };
    throw new Error(`シートセル更新失敗 (${response.status}): ${data.error?.message || 'unknown'}`);
  }

  console.log(`[sheet] セル更新完了: ${cellRange} = "${value}"`);
}
