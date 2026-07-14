import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bodyLimit } from 'hono/body-limit';
import { DB_COLS, FRANCHISES, type Database, type Franchise } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { executeCloudRunJob } from '../lib/cloud-run-jobs.js';
import { fetchHarakaDbSheetRows } from '../lib/haraka-db-sheet.js';
import { parseOrderListWorkbook } from '../lib/order-list-parser.js';
import {
  matchOrderListRows,
  type DbCardMatchInput,
  type ExistingProductMapping,
  type OrderListMatchResult,
} from '../lib/order-list-matcher.js';

export const orderListImportRoutes = new Hono();

const STORAGE_BUCKET = 'order-list-imports';
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_REQUEST_SIZE = 16 * 1024 * 1024;
const PAGE_SIZE = 1000;
const PARSER_VERSION = 'order-list-v1';
const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
const ORDER_LIST_SYNC_JOB_NAME = process.env.ORDER_LIST_SYNC_JOB_NAME?.trim() || 'haraka-manman-sync';
function isAuthorizedOrderListRequest(authorization: string | undefined): boolean {
  const expected = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!expected || expected.length < 32 || !authorization?.startsWith('Bearer ')) return false;

  const actual = authorization.slice('Bearer '.length).trim();
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes);
}

orderListImportRoutes.use('*', async (c, next) => {
  const configuredToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim();
  if (!configuredToken || configuredToken.length < 32) {
    return c.json({ error: 'オーダーリストAPIの認証設定がありません' }, 503);
  }
  if (!isAuthorizedOrderListRequest(c.req.header('authorization'))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});


type OrderListImportRow = Database['public']['Tables']['order_list_import']['Row'];
type OrderListItemRow = Database['public']['Tables']['order_list_item']['Row'];
type ExcelProductMappingRow = Database['public']['Tables']['excel_product_mapping']['Row'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];

type UploadedFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type OrderListMappingSelection = {
  item_id: string;
  db_card_id: string;
};

type OrderListConfirmPayload = {
  mappings: OrderListMappingSelection[];
  allowUnresolved: boolean;
};

type PayloadResult<T> = { ok: true; value: T } | { ok: false; error: string };
const MAX_CONFIRM_MAPPINGS = 1000;

export function parseOrderListMappingSelections(value: unknown): PayloadResult<OrderListMappingSelection[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'mappingsは配列で指定してください' };
  if (value.length > MAX_CONFIRM_MAPPINGS) {
    return { ok: false, error: `一度に対応付けできる件数は${MAX_CONFIRM_MAPPINGS}件までです` };
  }

  const seenItemIds = new Set<string>();
  const mappings: OrderListMappingSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'mappingsの各要素は商品IDの組み合わせで指定してください' };
    }
    const itemId = (entry as { item_id?: unknown }).item_id;
    const dbCardId = (entry as { db_card_id?: unknown }).db_card_id;
    if (typeof itemId !== 'string' || !itemId.trim()
      || typeof dbCardId !== 'string' || !dbCardId.trim()) {
      return { ok: false, error: 'item_idとdb_card_idは必須です' };
    }
    if (seenItemIds.has(itemId)) {
      return { ok: false, error: `同じitem_idが重複しています: ${itemId}` };
    }
    seenItemIds.add(itemId);
    mappings.push({ item_id: itemId, db_card_id: dbCardId });
  }
  return { ok: true, value: mappings };
}

export function parseOrderListConfirmPayload(value: unknown): PayloadResult<OrderListConfirmPayload> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '確認内容の形式が正しくありません' };
  }
  const payload = value as { mappings?: unknown; allow_unresolved?: unknown };
  const mappings = parseOrderListMappingSelections(payload.mappings ?? []);
  if (!mappings.ok) return mappings;
  if (payload.allow_unresolved !== undefined && typeof payload.allow_unresolved !== 'boolean') {
    return { ok: false, error: 'allow_unresolvedは真偽値で指定してください' };
  }
  return {
    ok: true,
    value: {
      mappings: mappings.value,
      allowUnresolved: payload.allow_unresolved === true,
    },
  };
}

type FranchiseSummary = {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  invalid: number;
};

type ImportSummary = FranchiseSummary & {
  by_franchise: Record<Franchise, FranchiseSummary>;
};

function emptyCounts(): FranchiseSummary {
  return { total: 0, matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
}

function summarizeMatches(results: OrderListMatchResult[]): ImportSummary {
  const byFranchise = Object.fromEntries(
    FRANCHISES.map((franchise) => [franchise, emptyCounts()]),
  ) as Record<Franchise, FranchiseSummary>;
  const total = emptyCounts();

  for (const result of results) {
    const franchiseCounts = byFranchise[result.row.franchise];
    total.total += 1;
    franchiseCounts.total += 1;
    total[result.status] += 1;
    franchiseCounts[result.status] += 1;
  }

  return { ...total, by_franchise: byFranchise };
}

function summaryFromImport(row: OrderListImportRow): ImportSummary {
  const stored = row.sheet_counts as unknown as Record<string, FranchiseSummary> | null;
  const byFranchise = Object.fromEntries(
    FRANCHISES.map((franchise) => [
      franchise,
      stored?.[franchise] ?? emptyCounts(),
    ]),
  ) as Record<Franchise, FranchiseSummary>;

  return {
    total: row.total_rows,
    matched: row.matched_rows,
    ambiguous: row.ambiguous_rows,
    unmatched: row.unmatched_rows,
    invalid: row.invalid_rows,
    by_franchise: byFranchise,
  };
}

function publicImport(row: OrderListImportRow) {
  return {
    id: row.id,
    filename: row.original_filename,
    business_date: row.business_date,
    status: row.status,
    imported_at: row.created_at,
    persistence_complete: row.persistence_complete,
    applied_summary: row.applied_summary,
    total_rows: row.total_rows,
    structural_valid: row.structural_valid,
  };
}

function persistenceErrorFromImport(row: OrderListImportRow): string | null {
  const summary = row.error_summary as { persistence_error?: unknown } | null;
  return typeof summary?.persistence_error === 'string' && summary.persistence_error.trim()
    ? summary.persistence_error
    : null;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UploadedFile>;
  return typeof candidate.name === 'string'
    && typeof candidate.size === 'number'
    && typeof candidate.arrayBuffer === 'function';
}

function businessDateFromFilename(filename: string): string {
  const match = filename.match(/(?:^|[^0-9])((?:20)?[0-9]{2})([01][0-9])([0-3][0-9])(?:[^0-9]|$)/);
  if (match) {
    const year = match[1].length === 2 ? '20' + match[1] : match[1];
    const candidate = year + '-' + match[2] + '-' + match[3];
    const parsed = new Date(candidate + 'T00:00:00Z');
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) {
      return candidate;
    }
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function safeFilename(filename: string): string {
  const safe = filename
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(-160);
  return safe || 'order-list.xlsx';

}
function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  // Opening the export in Excel must not execute workbook-controlled formulas.
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function mappingKey(franchise: string, excelProductId: string): string {
  const normalize = (value: string) => value.normalize('NFKC').trim()
    .replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
  return normalize(franchise)
    + '\u0000'
    + normalize(excelProductId);
}

function rowHash(row: {
  franchise: string;
  excelProductId: string;
  sheetName: string;
  sheetRowNumber: number;
  sourcePrice: number | null;
}): string {
  return createHash('sha256').update(JSON.stringify([
    row.franchise,
    row.excelProductId,
    row.sheetName,
    row.sheetRowNumber,
    row.sourcePrice,
  ])).digest('hex');
}

function countDuplicateRows(rows: Array<{ validationIssues: unknown[] }>): number {
  return rows.filter((row) => row.validationIssues.some((issue) => {
    if (!issue || typeof issue !== 'object') return false;
    const code = String((issue as { code?: unknown }).code ?? '');
    return code.includes('DUPLICATE');
  })).length;
}

function toPublicIssues(issues: unknown[]): Array<{
  severity?: string;
  code?: string;
  message: string;
  sheet?: string;
  row?: number;
  field?: string;
}> {
  return issues.map((issue) => {
    const value = (issue && typeof issue === 'object' ? issue : {}) as Record<string, unknown>;
    return {
      severity: typeof value.severity === 'string' ? value.severity : undefined,
      code: typeof value.code === 'string' ? value.code : undefined,
      message: typeof value.message === 'string' ? value.message : '不明な読み込みエラー',
      sheet: typeof value.sheetName === 'string' ? value.sheetName : undefined,
      row: typeof value.rowNumber === 'number' ? value.rowNumber : undefined,
      field: typeof value.field === 'string' ? value.field : undefined,
    };
  });
}

type DbCardSyncRow = {
  franchise: string;
  tag: string | null;
  card_name: string;
  grade: string;
  list_no: string;
  image_url: string | null;
  alt_image_url: string | null;
  rarity_icon: string | null;
  sheet_row_number: number;
};

function sheetCell(row: string[], column: number): string {
  return (row[column - 1] ?? '').trim();
}

function nullableSheetCell(row: string[], column: number): string | null {
  return sheetCell(row, column) || null;
}

async function refreshDbCardsFromHarakaSheet(
  supabase: SupabaseClient<Database>,
): Promise<void> {
  const sheetRows = await fetchHarakaDbSheetRows();
  if (sheetRows.length <= 1) {
    throw new Error('Haraka DBのDBタブに商品行がありません');
  }

  const deduped = new Map<string, DbCardSyncRow>();
  for (let index = 1; index < sheetRows.length; index += 1) {
    const row = sheetRows[index];
    const cardName = sheetCell(row, DB_COLS.CARD_NAME);
    const franchise = sheetCell(row, DB_COLS.FRANCHISE);
    if (!cardName || !FRANCHISES.includes(franchise as Franchise)) continue;

    const grade = sheetCell(row, DB_COLS.TYPE);
    const listNo = sheetCell(row, DB_COLS.CARD_NO);
    deduped.set([franchise, cardName, grade, listNo].join('|'), {
      franchise,
      tag: nullableSheetCell(row, DB_COLS.GROUP),
      card_name: cardName,
      grade,
      list_no: listNo,
      image_url: nullableSheetCell(row, DB_COLS.IMAGE),
      alt_image_url: nullableSheetCell(row, DB_COLS.ALT_IMAGE),
      rarity_icon: nullableSheetCell(row, DB_COLS.RARITY_ICON),
      sheet_row_number: index + 1,
    });
  }

  const rows = [...deduped.values()];
  if (rows.length === 0) throw new Error('Haraka DBから有効な商品を取得できませんでした');

  for (let index = 0; index < rows.length; index += 400) {
    const { error } = await supabase
      .from('db_card')
      .upsert(
        rows.slice(index, index + 400) as unknown as Database['public']['Tables']['db_card']['Insert'][],
        { onConflict: 'franchise,card_name,grade,list_no' },
      );
    if (error) throw new Error('db_card最新化失敗: ' + error.message);
  }
}

async function fetchAllDbCards(
  supabase: SupabaseClient<Database>,
): Promise<DbCardMatchInput[]> {
  const rows: DbCardMatchInput[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('db_card')
      .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<DbCardMatchInput[]>();
    if (error) throw new Error('db_card取得失敗: ' + error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllMappings(
  supabase: SupabaseClient<Database>,
): Promise<ExistingProductMapping[]> {
  const rows: ExistingProductMapping[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('excel_product_mapping')
      .select('id, franchise, excel_product_id, db_card_id, status')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<ExistingProductMapping[]>();
    if (error) throw new Error('Excel商品対応表取得失敗: ' + error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function saveAutoMappings(
  supabase: SupabaseClient<Database>,
  importId: string,
  results: OrderListMatchResult[],
): Promise<Map<string, ExcelProductMappingRow>> {
  const insertByKey = new Map<string, Database['public']['Tables']['excel_product_mapping']['Insert']>();

  for (const result of results) {
    if (
      result.status !== 'matched'
      || !result.dbCardId
      || (result.method !== 'exact_image' && result.method !== 'exact_identity')
    ) continue;

    const key = mappingKey(result.row.franchise, result.row.excelProductId);
    insertByKey.set(key, {
      franchise: result.row.franchise,
      excel_product_id: result.row.excelProductId,
      db_card_id: result.dbCardId,
      status: 'active',
      match_method: result.method,
      first_seen_import_id: importId,
      last_seen_import_id: importId,
    });
  }

  const inserts = [...insertByKey.values()];
  for (let i = 0; i < inserts.length; i += 400) {
    const { error } = await supabase
      .from('excel_product_mapping')
      .upsert(inserts.slice(i, i + 400), {
        onConflict: 'franchise,excel_product_key',
        ignoreDuplicates: true,
      });
    if (error) throw new Error('Excel商品対応表保存失敗: ' + error.message);
  }

  const allMappings: ExcelProductMappingRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('excel_product_mapping')
      .select('*')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<ExcelProductMappingRow[]>();
    if (error) throw new Error('Excel商品対応表再取得失敗: ' + error.message);
    allMappings.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const byKey = new Map(
    allMappings.map((mapping) => [
      mappingKey(mapping.franchise, mapping.excel_product_id),
      mapping,
    ]),
  );

  // 対応先DB商品が削除された後に厳密照合で再発見できた場合だけ、
  // activeな既存対応を安全に修復する。disabledは人の判断として維持する。
  for (const result of results) {
    if (
      result.status !== 'matched'
      || !result.dbCardId
      || (result.method !== 'exact_image' && result.method !== 'exact_identity')
    ) continue;
    const key = mappingKey(result.row.franchise, result.row.excelProductId);
    const mapping = byKey.get(key);
    if (!mapping || mapping.status !== 'active' || mapping.db_card_id === result.dbCardId) continue;

    const { data, error } = await supabase
      .from('excel_product_mapping')
      .update({
        db_card_id: result.dbCardId,
        match_method: result.method,
        last_seen_import_id: importId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', mapping.id)
      .select('*')
      .single<ExcelProductMappingRow>();
    if (error || !data) {
      throw new Error('Excel商品対応表の再照合保存失敗: ' + (error?.message ?? 'unknown'));
    }
    byKey.set(key, data);
  }

  const seenIds = new Set<string>();
  for (const result of results) {
    if (result.status !== 'matched') continue;
    const mapping = byKey.get(mappingKey(result.row.franchise, result.row.excelProductId));
    if (mapping) seenIds.add(mapping.id);
  }

  const ids = [...seenIds];
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase
      .from('excel_product_mapping')
      .update({
        last_seen_import_id: importId,
        updated_at: new Date().toISOString(),
      })
      .in('id', ids.slice(i, i + 200));
    if (error) throw new Error('Excel商品対応表の最終確認日更新失敗: ' + error.message);
  }

  return new Map(
    [...byKey].filter(([, mapping]) => mapping.status === 'active'),
  );
}

orderListImportRoutes.get('/order-list/runs/:id/csv', async (c) => {
  const runId = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: run, error: runError } = await supabase
    .from('run')
    .select('id')
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (runError) return c.json({ error: runError.message }, 500);
  if (!run) return c.json({ error: 'Runが見つかりません' }, 404);

  const { data, error } = await supabase
    .from('raw_import')
    .select('franchise, excel_product_id, card_name, grade, list_no, rarity, source_price, demand, image_url')
    .eq('run_id', runId)
    .eq('price_source', 'order_list')
    .order('franchise')
    .order('source_price', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'データがありません' }, 404);

  const headers = ['フランチャイズ', 'Excel商品ID', 'カード名', 'グレード', '品番', 'レアリティ', '納品希望価格(税込)', '募集数', '画像URL'];
  const rows = data.map((row) => [
    row.franchise,
    row.excel_product_id,
    row.card_name,
    row.grade,
    row.list_no,
    row.rarity,
    row.source_price,
    row.demand,
    row.image_url,
  ].map(csvCell).join(','));
  const csv = '\uFEFF' + [headers.map(csvCell).join(','), ...rows].join('\r\n');
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="order_list_${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});


orderListImportRoutes.get('/order-list/db-cards', async (c) => {
  const franchise = c.req.query('franchise') as Franchise | undefined;
  if (!franchise || !FRANCHISES.includes(franchise)) {
    return c.json({ error: 'franchiseの指定が正しくありません' }, 400);
  }

  type DbCardChoice = Pick<DbCardRow, 'id' | 'franchise' | 'tag' | 'card_name' | 'grade' | 'list_no' | 'image_url' | 'alt_image_url'>;
  const supabase = createSupabaseClient();
  const rows: DbCardChoice[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('db_card')
      .select('id, franchise, tag, card_name, grade, list_no, image_url, alt_image_url')
      .eq('franchise', franchise)
      .order('card_name')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<DbCardChoice[]>();
    if (error) return c.json({ error: error.message }, 500);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return c.json(rows);
});

orderListImportRoutes.get('/order-list/imports', async (c) => {
  const supabase = createSupabaseClient();
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 20), 1), 100);
  const { data, error } = await supabase
    .from('order_list_import')
    .select('*')
    .eq('store', STORE_NAME)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<OrderListImportRow[]>();

  if (error) return c.json({ error: error.message }, 500);
  return c.json((data ?? []).map((row) => ({
    import: publicImport(row),
    summary: summaryFromImport(row),
  })));
});

orderListImportRoutes.get('/order-list/imports/:id', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('order_list_import')
    .select('*')
    .eq('id', c.req.param('id'))
    .eq('store', STORE_NAME)
    .maybeSingle<OrderListImportRow>();

  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  return c.json({
    import: publicImport(data),
    summary: summaryFromImport(data),
    issues: (data.error_summary as { issues?: unknown[] } | null)?.issues ?? [],
  });
});

orderListImportRoutes.get('/order-list/imports/:id/items', async (c) => {
  const supabase = createSupabaseClient();
  const importId = c.req.param('id');
  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  const page = Math.max(Number(c.req.query('page') || 1), 1);
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 100), 1), 200);
  const status = c.req.query('status');
  const from = (page - 1) * limit;

  let query = supabase
    .from('order_list_item')
    .select('*', { count: 'exact' })
    .eq('import_id', importId);
  if (status && ['matched', 'ambiguous', 'unmatched', 'invalid'].includes(status)) {
    query = query.eq('match_status', status as OrderListItemRow['match_status']);
  }

  const { data, error, count } = await query
    .order('sheet_name')
    .order('sheet_row_number')
    .range(from, from + limit - 1)
    .returns<OrderListItemRow[]>();

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ items: data ?? [], page, limit, total: count ?? 0 });
});

orderListImportRoutes.post('/order-list/imports', bodyLimit({
  maxSize: MAX_REQUEST_SIZE,
  onError: (c) => c.json({ error: 'アップロード全体は16MB以下にしてください' }, 413),
}), async (c) => {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_FILE_SIZE + 1024 * 1024) {
    return c.json({ error: 'ファイルサイズは15MB以下にしてください' }, 413);
  }

  const body = await c.req.parseBody();
  const candidate = body.file ?? body.order_list;
  if (!isUploadedFile(candidate)) {
    return c.json({ error: 'fileフィールドに.xlsxファイルを指定してください' }, 400);
  }
  if (!candidate.name.toLowerCase().endsWith('.xlsx')) {
    return c.json({ error: '.xlsx形式のオーダーリストだけ読み込めます' }, 400);
  }
  if (candidate.size <= 0 || candidate.size > MAX_FILE_SIZE) {
    return c.json({ error: 'ファイルサイズは1バイト以上15MB以下にしてください' }, 413);
  }

  const buffer = Buffer.from(await candidate.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_SIZE) {
    return c.json({ error: 'ファイルサイズは15MB以下にしてください' }, 413);
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const businessDate = businessDateFromFilename(candidate.name);
  const supabase = createSupabaseClient();

  const { data: duplicate, error: duplicateError } = await supabase
    .from('order_list_import')
    .select('*')
    .eq('store', STORE_NAME)
    .eq('business_date', businessDate)
    .eq('sha256', sha256)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderListImportRow>();
  if (duplicateError) return c.json({ error: duplicateError.message }, 500);
  if (duplicate) {
    const persistenceError = persistenceErrorFromImport(duplicate);
    if (persistenceError || !duplicate.persistence_complete) {
      if (['confirmed', 'processing', 'applied'].includes(duplicate.status)) {
        return c.json({
          error: '反映中または反映済みの不完全取込は自動削除できません。管理者確認が必要です',
        }, 409);
      }

      const { error: storageCleanupError } = await supabase.storage
        .from(duplicate.storage_bucket)
        .remove([duplicate.storage_path]);
      if (storageCleanupError) {
        return c.json({ error: '失敗取込の原本を整理できません: ' + storageCleanupError.message }, 500);
      }

      const { error: mappingCleanupError } = await supabase
        .from('excel_product_mapping')
        .delete()
        .eq('first_seen_import_id', duplicate.id)
        .eq('last_seen_import_id', duplicate.id);
      if (mappingCleanupError) {
        return c.json({ error: '失敗取込の対応表を整理できません: ' + mappingCleanupError.message }, 500);
      }

      const { error: importCleanupError } = await supabase
        .from('order_list_import')
        .delete()
        .eq('id', duplicate.id)
        .eq('store', STORE_NAME);
      if (importCleanupError) {
        return c.json({ error: '失敗取込を再作成できません: ' + importCleanupError.message }, 500);
      }
    } else {
      return c.json({
        import: publicImport(duplicate),
        summary: summaryFromImport(duplicate),
        issues: (duplicate.error_summary as { issues?: unknown[] } | null)?.issues ?? [],
        duplicate: true,
      });
    }
  }

  let parsed: Awaited<ReturnType<typeof parseOrderListWorkbook>>;
  try {
    parsed = await parseOrderListWorkbook(buffer);
  } catch (error) {
    return c.json({
      error: 'Excelの解析に失敗しました',
      detail: error instanceof Error ? error.message : String(error),
    }, 422);
  }

  let matches: OrderListMatchResult<(typeof parsed.rows)[number]>[];
  if (parsed.structuralValid) {
    try {
      await refreshDbCardsFromHarakaSheet(supabase);
    } catch (error) {
      return c.json({
        error: '商品DBの最新化に失敗したためExcelを照合できません',
        detail: error instanceof Error ? error.message : String(error),
      }, 502);
    }

    const [dbCards, existingMappings] = await Promise.all([
      fetchAllDbCards(supabase),
      fetchAllMappings(supabase),
    ]);
    matches = matchOrderListRows(parsed.rows, dbCards, existingMappings);
  } else {
    // 構造不正のファイルはDB最新化も自動照合も行わず、原本と行だけを
    // 監査用に保存する。アップロードエラーをDB同期障害で上書きしない。
    matches = parsed.rows.map((row) => ({
      row,
      status: 'invalid',
      method: null,
      dbCardId: null,
      mappingId: null,
      candidateDbCardIds: [],
      note: 'Excel全体のシート構成または必須ヘッダーにエラーがあります',
    }));
  }
  const summary = summarizeMatches(matches);
  const importId = randomUUID();
  const filename = safeFilename(candidate.name);
  const storagePath = [STORE_NAME, businessDate, importId, filename].join('/');
  const publicIssues = toPublicIssues(parsed.issues);
  const issuesPayload = { issues: publicIssues };
  const duplicateRows = countDuplicateRows(parsed.rows);

  const { data: importRow, error: importError } = await supabase
    .from('order_list_import')
    .insert({
      id: importId,
      store: STORE_NAME,
      business_date: businessDate,
      status: parsed.structuralValid ? 'parsed' : 'failed',
      structural_valid: parsed.structuralValid,
      original_filename: candidate.name,
      original_mime_type: candidate.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      uploaded_by: 'web-ui',
      original_size_bytes: candidate.size,
      sha256,
      storage_bucket: STORAGE_BUCKET,
      storage_path: storagePath,
      parser_version: PARSER_VERSION,
      sheet_counts: summary.by_franchise,
      total_rows: summary.total,
      valid_rows: summary.matched + summary.ambiguous + summary.unmatched,
      matched_rows: summary.matched,
      unmatched_rows: summary.unmatched,
      ambiguous_rows: summary.ambiguous,
      invalid_rows: summary.invalid,
      duplicate_rows: duplicateRows,
      error_summary: issuesPayload,
    })
    .select('*')
    .single<OrderListImportRow>();

  if (importError || !importRow) {
    return c.json({ error: '取込記録の作成に失敗しました: ' + (importError?.message ?? 'unknown') }, 500);
  }

  let persistedImport = importRow;
  try {
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: candidate.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });
    if (storageError) throw new Error('原本保存失敗: ' + storageError.message);

    const mappingsByKey = parsed.structuralValid
      ? await saveAutoMappings(supabase, importId, matches)
      : new Map<string, ExcelProductMappingRow>();
    const matchedAt = new Date().toISOString();
    const itemRows: Database['public']['Tables']['order_list_item']['Insert'][] = matches.map((result) => {
      const row = result.row as (typeof parsed.rows)[number];
      const mapping = mappingsByKey.get(mappingKey(row.franchise, row.excelProductId));
      return {
        import_id: importId,
        franchise: row.franchise,
        excel_product_id: row.excelProductId,
        sheet_name: row.sheetName,
        sheet_row_number: row.sheetRowNumber,
        card_name: row.cardName,
        grade: row.grade,
        expansion: row.expansion,
        list_no: row.listNo,
        rarity: row.rarity,
        image_url: row.imageUrl,
        demand: row.demand,
        source_price: row.sourcePrice,
        raw_row: row.rawRow,
        row_hash: rowHash(row),
        mapping_id: mapping?.id ?? result.mappingId,
        db_card_id: result.dbCardId,
        match_status: result.status,
        match_method: result.method,
        match_note: result.note,
        match_candidates: result.candidateDbCardIds,
        validation_issues: row.validationIssues,
        matched_at: result.status === 'matched' ? matchedAt : null,
      };
    });

    for (let i = 0; i < itemRows.length; i += 400) {
      const { error } = await supabase
        .from('order_list_item')
        .insert(itemRows.slice(i, i + 400));
      if (error) throw new Error('Excel行保存失敗: ' + error.message);
    }

    const { data: completedImport, error: completionError } = await supabase
      .from('order_list_import')
      .update({ persistence_complete: true, updated_at: new Date().toISOString() })
      .eq('id', importId)
      .eq('store', STORE_NAME)
      .eq('persistence_complete', false)
      .select('*')
      .maybeSingle<OrderListImportRow>();
    if (completionError || !completedImport) {
      throw new Error('取込データの保存完了を確定できません: ' + (completionError?.message ?? 'state changed'));
    }
    persistedImport = completedImport;
  } catch (error) {
    const persistenceMessage = error instanceof Error ? error.message : String(error);
    const { error: markerError } = await supabase
      .from('order_list_import')
      .update({
        status: 'failed',
        persistence_complete: false,
        error_summary: {
          issues: publicIssues,
          persistence_error: persistenceMessage,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', importId)
      .eq('store', STORE_NAME);
    if (markerError) {
      console.error('[order-list] failed to persist failure marker:', markerError.message);
    }

    return c.json({
      error: persistenceMessage,
      import_id: importId,
      ...(markerError ? { state_error: markerError.message } : {}),
    }, 500);
  }

  return c.json({
    import: publicImport(persistedImport),
    summary,
    issues: publicIssues,
  }, 201);
});

orderListImportRoutes.patch('/order-list/imports/:id/items/:itemId/mapping', async (c) => {
  const importId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const payload = await c.req.json<{ db_card_id?: string }>();
  if (!payload.db_card_id) return c.json({ error: 'db_card_idは必須です' }, 400);

  const supabase = createSupabaseClient();
  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  const { data, error } = await supabase.rpc('resolve_order_list_item_mapping', {
    p_import_id: importId,
    p_item_id: itemId,
    p_db_card_id: payload.db_card_id,
  });
  if (error) {
    const status = error.code === 'P0002'
      ? 404
      : error.code === '22023'
        ? 422
        : error.code === '55000'
          ? 409
          : 500;
    return c.json({ error: error.message }, status);
  }

  return c.json(data);
});

orderListImportRoutes.patch('/order-list/imports/:id/mappings', async (c) => {
  const importId = c.req.param('id');
  const payload = await c.req.json<unknown>().catch(() => null);
  const rawMappings = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { mappings?: unknown }).mappings
    : undefined;
  const parsed = parseOrderListMappingSelections(rawMappings);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (parsed.value.length === 0) return c.json({ error: '保存する対応付けを1件以上選択してください' }, 400);

  const supabase = createSupabaseClient();
  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  const { data, error } = await supabase.rpc('resolve_order_list_item_mappings', {
    p_import_id: importId,
    p_mappings: parsed.value,
    p_allow_unresolved: true,
  });
  if (error) {
    const status = error.code === 'P0002'
      ? 404
      : error.code === '22023'
        ? 422
        : error.code === '55000'
          ? 409
          : 500;
    return c.json({ error: error.message }, status);
  }

  return c.json(data);
});

orderListImportRoutes.post('/order-list/imports/:id/confirm', async (c) => {
  const importId = c.req.param('id');
  let rawPayload: unknown = {};
  if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    try {
      rawPayload = await c.req.json<unknown>();
    } catch {
      return c.json({ error: '確認内容のJSONが正しくありません' }, 400);
    }
  }
  const parsedPayload = parseOrderListConfirmPayload(rawPayload);
  if (!parsedPayload.ok) return c.json({ error: parsedPayload.error }, 400);
  const confirmPayload = parsedPayload.value;

  const supabase = createSupabaseClient();
  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { error: staleRecoveryError } = await supabase.rpc('recover_stale_order_list_imports_for_store', {
    p_store: STORE_NAME,
    p_stale_before: staleBefore,
  });
  if (staleRecoveryError) return c.json({ error: staleRecoveryError.message }, 500);


  const { data: importRow, error } = await supabase
    .from('order_list_import')
    .select('*')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle<OrderListImportRow>();
  if (error) return c.json({ error: error.message }, 500);
  if (!importRow) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);
  if (!importRow.structural_valid) {
    return c.json({ error: 'シート構成または必須ヘッダにエラーがあるため反映できません' }, 422);
  }

  const persistenceError = persistenceErrorFromImport(importRow);
  if (!importRow.persistence_complete || persistenceError) {
    return c.json({
      error: '取込データの保存が完了していないため反映できません。失敗記録の確認が必要です',
      ...(persistenceError ? { detail: persistenceError } : {}),
    }, 409);
  }

  if (importRow.status === 'parsed' || importRow.status === 'failed') {
    const { error: mappingError } = await supabase.rpc('resolve_order_list_item_mappings', {
      p_import_id: importId,
      p_mappings: confirmPayload.mappings,
      p_allow_unresolved: confirmPayload.allowUnresolved,
    });
    if (mappingError) {
      const status = mappingError.code === 'P0002'
        ? 404
        : mappingError.code === '22023'
          ? 422
          : mappingError.code === '55000'
            ? 409
            : 500;
      return c.json({ error: mappingError.message }, status);
    }
  } else if (confirmPayload.mappings.length > 0) {
    return c.json({ error: '現在の取込状態では商品対応を変更できません' }, 409);
  }

  const [
    { count: persistedItemRows, error: itemCountError },
    { count: persistedMatchedRows, error: matchedCountError },
  ] = await Promise.all([
    supabase
      .from('order_list_item')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importId),
    supabase
      .from('order_list_item')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importId)
      .eq('match_status', 'matched')
      .not('db_card_id', 'is', null),
  ]);
  if (itemCountError || matchedCountError) {
    return c.json({ error: itemCountError?.message ?? matchedCountError?.message }, 500);
  }
  if (persistedItemRows !== importRow.total_rows) {
    return c.json({
      error: `取込行の保存件数が一致しないため反映できません（expected=${importRow.total_rows}, actual=${persistedItemRows ?? 0}）`,
    }, 409);
  }
  if (!persistedMatchedRows) {
    return c.json({ error: '照合済みの商品が0件のため反映できません' }, 422);
  }

  const { data: existingRun, error: existingRunError } = await supabase
    .from('run')
    .select('id, status')
    .eq('order_list_import_id', importId)
    .eq('store', STORE_NAME)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRunError) return c.json({ error: existingRunError.message }, 500);

  if (existingRun && (existingRun.status === 'running' || existingRun.status === 'completed')) {
    return c.json({
      import_id: importId,
      status: importRow.status,
      sync_started: false,
      run_id: existingRun.id,
    });
  }
  if (importRow.status === 'confirmed') {
    return c.json({
      import_id: importId,
      status: 'confirmed',
      sync_started: false,
    });
  }
  if (importRow.status === 'processing' || importRow.status === 'applied') {
    return c.json({ error: 'このオーダーリストは既に反映処理中または反映済みです' }, 409);
  }

  const [
    { data: otherActiveImport, error: activeImportError },
    { data: activeRun, error: activeRunError },
  ] = await Promise.all([
    supabase
      .from('order_list_import')
      .select('id')
      .eq('store', STORE_NAME)
      .neq('id', importId)
      .in('status', ['confirmed', 'processing'])
      .limit(1)
      .maybeSingle(),
    supabase
      .from('run')
      .select('id')
      .eq('store', STORE_NAME)
      .eq('status', 'running')
      .limit(1)
      .maybeSingle(),
  ]);
  if (activeImportError || activeRunError) {
    return c.json({ error: activeImportError?.message ?? activeRunError?.message }, 500);
  }
  if (otherActiveImport || activeRun) {
    return c.json({ error: '別のオーダーリスト反映または生成処理が実行中です。完了後に再実行してください' }, 409);
  }

  const previousStatus = importRow.status;
  const { data: confirmedImport, error: confirmError } = await supabase
    .from('order_list_import')
    .update({
      status: 'confirmed',
      error_summary: { issues: (importRow.error_summary as { issues?: unknown[] } | null)?.issues ?? [] },
      confirmed_at: new Date().toISOString(),
      confirmed_by: 'web-ui',
      processing_started_at: null,
      heartbeat_at: null,
      updated_at: new Date().toISOString(),
      failed_at: null,
      failure_message: null,
    })
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .eq('status', previousStatus)
    .select('id')
    .maybeSingle();
  if (confirmError) {
    const status = confirmError.code === '23505' ? 409 : 500;
    return c.json({
      error: status === 409 ? '別のオーダーリスト反映が先に開始されました' : confirmError.message,
    }, status);
  }
  if (!confirmedImport) {
    return c.json({ error: '取込状態が更新されたため、最新状態を確認してください' }, 409);
  }

  try {
    const job = await executeCloudRunJob(ORDER_LIST_SYNC_JOB_NAME, {
      env: {
        ORDER_LIST_IMPORT_ID: importId,
        TRIGGER: 'web-ui',
        STORE_NAME,
      },
    });
    return c.json({
      import_id: importId,
      status: 'confirmed',
      sync_started: true,
      job: {
        operation: job.operationName,
        execution: job.executionName,
      },
    });
  } catch (jobError) {
    const { error: rollbackError } = await supabase
      .from('order_list_import')
      .update({
        status: previousStatus,
        error_summary: importRow.error_summary,
        confirmed_at: importRow.confirmed_at,
        confirmed_by: importRow.confirmed_by,
        processing_started_at: importRow.processing_started_at,
        heartbeat_at: importRow.heartbeat_at,
        failed_at: importRow.failed_at,
        failure_message: importRow.failure_message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', importId)
      .eq('store', STORE_NAME)
      .eq('status', 'confirmed');
    return c.json({
      error: '同期ジョブの起動に失敗しました: '
        + (jobError instanceof Error ? jobError.message : String(jobError)),
      ...(rollbackError ? { state_error: '取込状態の巻き戻しにも失敗しました: ' + rollbackError.message } : {}),
    }, 500);
  }
});
