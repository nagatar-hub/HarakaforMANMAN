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

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(`Access token取得失敗: ${data.error}`);
  }

  const data = await response.json() as { access_token: string };
  return data.access_token;
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
  const spreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
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

  const response = await fetch(url, {
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
  });

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
  const spreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
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

  const response = await fetch(url, {
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
  });

  if (!response.ok) {
    const data = await response.json() as { error?: { message?: string } };
    throw new Error(`シートセル更新失敗 (${response.status}): ${data.error?.message || 'unknown'}`);
  }

  console.log(`[sheet] セル更新完了: ${cellRange} = "${value}"`);
}
