/**
 * Google Sheets API ユーティリティ
 *
 * refresh token から access token を取得し、スプレッドシートの値を読み取る。
 * 外部ライブラリに依存せず、fetch API のみを使用。
 */

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// ---------------------------------------------------------------------------
// 内部型定義
// ---------------------------------------------------------------------------

interface TokenSuccessResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

interface SheetValuesResponse {
  range: string;
  majorDimension: string;
  values?: string[][];
}

interface AppendValuesResponse {
  spreadsheetId: string;
  tableRange: string;
  updates: {
    updatedRange: string;
    updatedRows: number;
    updatedColumns: number;
    updatedCells: number;
  };
}

interface SheetErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * refresh token を使って access token を取得する。
 *
 * Google OAuth token endpoint に grant_type=refresh_token を送信し、
 * 新しい access token を文字列で返す。
 *
 * @param params.refreshToken - 保存済みの refresh token
 * @param params.clientId     - OAuth クライアント ID
 * @param params.clientSecret - OAuth クライアントシークレット
 * @returns 新しい access token
 * @throws トークン取得に失敗した場合
 */
export async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  }).toString();

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Google token endpoint へのネットワークエラー: ${message}`);
  }

  const data: unknown = await response.json();

  if (!response.ok) {
    const errorData = data as TokenErrorResponse;
    const description = errorData.error_description ? ` — ${errorData.error_description}` : '';
    throw new Error(`アクセストークンの取得に失敗しました: ${errorData.error}${description}`);
  }

  const tokenData = data as TokenSuccessResponse;
  if (!tokenData.access_token) {
    throw new Error('レスポンスに access_token が含まれていません');
  }

  return tokenData.access_token;
}

/**
 * Google Sheets API でスプレッドシートのセル値を取得する。
 *
 * values.get エンドポイントを呼び出し、指定範囲の 2D 文字列配列を返す。
 * 空のスプレッドシートなど values が存在しない場合は空配列を返す。
 *
 * @param params.accessToken    - 有効な OAuth access token
 * @param params.spreadsheetId  - Google スプレッドシートの ID
 * @param params.range          - A1 記法のセル範囲（例: "Sheet1!A1:Z100"）
 * @returns セル値の 2D 文字列配列
 * @throws API 呼び出しに失敗した場合
 */
export async function fetchSheetValues(params: {
  accessToken: string;
  spreadsheetId: string;
  range: string;
}): Promise<string[][]> {
  const encodedRange = encodeURIComponent(params.range);
  const url = `${GOOGLE_SHEETS_API_BASE}/${params.spreadsheetId}/values/${encodedRange}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Sheets API へのネットワークエラー: ${message}`);
  }

  const data: unknown = await response.json();

  if (!response.ok) {
    const errorData = data as SheetErrorResponse;
    throw new Error(
      `スプレッドシートの値取得に失敗しました (HTTP ${errorData.error.code}): ${errorData.error.message}`
    );
  }

  const sheetData = data as SheetValuesResponse;
  return sheetData.values ?? [];
}

/**
 * Google Sheets API でスプレッドシートに行を追加する。
 *
 * values.append エンドポイントを呼び出し、指定範囲の末尾に行を追加する。
 * Haraka DB シートへのタグ書き戻しに使用。
 *
 * @param params.accessToken    - 有効な OAuth access token
 * @param params.spreadsheetId  - Google スプレッドシートの ID
 * @param params.range          - A1 記法のシート範囲（例: "Pokemon!A:H"）
 * @param params.values         - 追加する行データの 2D 文字列配列
 * @returns 追加された行数
 * @throws API 呼び出しに失敗した場合
 */
export async function appendSheetValues(params: {
  accessToken: string;
  spreadsheetId: string;
  range: string;
  values: string[][];
}): Promise<number> {
  const encodedRange = encodeURIComponent(params.range);
  const url = `${GOOGLE_SHEETS_API_BASE}/${params.spreadsheetId}/values/${encodedRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: params.range,
        majorDimension: 'ROWS',
        values: params.values,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Sheets API への書き込みネットワークエラー: ${message}`);
  }

  const data: unknown = await response.json();

  if (!response.ok) {
    const errorData = data as SheetErrorResponse;
    throw new Error(
      `スプレッドシートへの書き込みに失敗しました (HTTP ${errorData.error.code}): ${errorData.error.message}`
    );
  }

  const appendData = data as AppendValuesResponse;
  return appendData.updates?.updatedRows ?? 0;
}
