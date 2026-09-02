import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bodyLimit } from 'hono/body-limit';
import { DB_COLS, FRANCHISES, type Database, type Franchise } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { executeCloudRunJob } from '../lib/cloud-run-jobs.js';
import { isDefinitiveCloudRunJobRejection } from '../lib/cloud-run-errors.js';
import { authorizeInternalApiRequest } from '../lib/internal-api-auth.js';
import { fetchHarakaDbSheetRows } from '../lib/haraka-db-sheet.js';
import {
  ORDER_LIST_ALLOWED_IMAGE_HOSTS,
  ORDER_LIST_MAX_DATA_ROWS,
  parseOrderListWorkbook,
} from '../lib/order-list-parser.js';
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
const PARSER_VERSION = 'order-list-v3';
const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
const ORDER_LIST_SYNC_JOB_NAME = process.env.ORDER_LIST_SYNC_JOB_NAME?.trim() || `haraka-${STORE_NAME}-sync`;
orderListImportRoutes.use('*', async (c, next) => {
  const auth = authorizeInternalApiRequest(c.req.header('authorization'));
  if (auth === 'misconfigured') {
    return c.json({ error: 'オーダーリストAPIの認証設定がありません' }, 503);
  }
  if (auth !== 'authorized') {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});


type OrderListImportRow = Database['public']['Tables']['order_list_import']['Row'];
type OrderListItemRow = Database['public']['Tables']['order_list_item']['Row'];
type ExcelProductMappingRow = Database['public']['Tables']['excel_product_mapping']['Row'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];
type OrderListImportRecencyRow = Pick<
  OrderListImportRow,
  | 'id'
  | 'business_date'
  | 'created_at'
  | 'original_filename'
  | 'status'
  | 'structural_valid'
  | 'persistence_complete'
>;
type OrderListImportRecencyTarget = Pick<
  OrderListImportRow,
  'id' | 'business_date' | 'created_at'
>;

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

type OrderListNewCardSelection = {
  item_id: string;
  card_name: string;
  grade: string;
  list_no: string;
  tag: string;
  alt_image_url: string | null;
};

type OrderListExclusionSelection = {
  item_id: string;
};

type OrderListSelectionsPayload = {
  mappings: OrderListMappingSelection[];
  newCards: OrderListNewCardSelection[];
  exclusions: OrderListExclusionSelection[];
};

export type OrderListConfirmPayload = OrderListSelectionsPayload & {
  allowUnresolved: boolean;
};

type OrderListResyncPayload = OrderListConfirmPayload & {
  requestId: string;
};

type PayloadResult<T> = { ok: true; value: T } | { ok: false; error: string };
const MAX_CONFIRM_SELECTIONS = ORDER_LIST_MAX_DATA_ROWS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedNewCardImageHosts = new Set<string>([
  ...ORDER_LIST_ALLOWED_IMAGE_HOSTS,
]);

export async function findCurrentParserDuplicate(
  supabase: SupabaseClient<Database>,
  businessDate: string,
  sha256: string,
) {
  return supabase
    .from('order_list_import')
    .select('*')
    .eq('store', STORE_NAME)
    .eq('business_date', businessDate)
    .eq('parser_version', PARSER_VERSION)
    .eq('sha256', sha256)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderListImportRow>();
}

export function canEditOrderListMappings(importStatus: unknown): boolean {
  return importStatus === 'applied';
}

// A failed import can still be a structurally valid, fully persisted workbook
// whose sync failed and is eligible for resync. Keep it in the superseding set;
// parser/persistence failures are excluded by the two integrity flags below.
const SUPERSEDING_ORDER_LIST_IMPORT_STATUSES: OrderListImportRow['status'][] = [
  'parsed',
  'confirmed',
  'processing',
  'applied',
  'failed',
];

export function isNewerUsableOrderListImport(
  target: OrderListImportRecencyTarget,
  candidate: OrderListImportRecencyRow,
): boolean {
  if (candidate.id === target.id
    || !candidate.structural_valid
    || !candidate.persistence_complete
    || !SUPERSEDING_ORDER_LIST_IMPORT_STATUSES.includes(candidate.status)) {
    return false;
  }
  if (candidate.business_date !== target.business_date) {
    return candidate.business_date > target.business_date;
  }

  const candidateCreatedAt = Date.parse(candidate.created_at);
  const targetCreatedAt = Date.parse(target.created_at);
  return Number.isFinite(candidateCreatedAt)
    && Number.isFinite(targetCreatedAt)
    && candidateCreatedAt > targetCreatedAt;
}

type NewerImportGuardResult =
  | { ok: true }
  | {
    ok: false;
    status: 409 | 500;
    body: {
      error: string;
      latest_import?: {
        id: string;
        original_filename: string;
        business_date: string;
      };
    };
  };

async function guardAgainstNewerOrderListImport(
  supabase: SupabaseClient<Database>,
  target: OrderListImportRecencyTarget,
): Promise<NewerImportGuardResult> {
  const { data: candidate, error } = await supabase
    .from('order_list_import')
    .select('id, business_date, created_at, original_filename, status, structural_valid, persistence_complete')
    .eq('store', STORE_NAME)
    .eq('structural_valid', true)
    .eq('persistence_complete', true)
    .in('status', SUPERSEDING_ORDER_LIST_IMPORT_STATUSES)
    .neq('id', target.id)
    .gte('business_date', target.business_date)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderListImportRecencyRow>();
  if (error) {
    return { ok: false, status: 500, body: { error: error.message } };
  }
  if (!candidate || !isNewerUsableOrderListImport(target, candidate)) {
    return { ok: true };
  }

  return {
    ok: false,
    status: 409,
    body: {
      error: `より新しい有効なオーダーリスト「${candidate.original_filename}」（業務日: ${candidate.business_date}）が存在するため、この取込は確定・再同期できません`,
      latest_import: {
        id: candidate.id,
        original_filename: candidate.original_filename,
        business_date: candidate.business_date,
      },
    },
  };
}

export { isDefinitiveCloudRunJobRejection } from '../lib/cloud-run-errors.js';

export function parseOrderListMappingSelections(value: unknown): PayloadResult<OrderListMappingSelection[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'mappingsは配列で指定してください' };
  if (value.length > MAX_CONFIRM_SELECTIONS) {
    return { ok: false, error: `一度に対応付けできる件数は${MAX_CONFIRM_SELECTIONS}件までです` };
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

export function parseOrderListExclusionSelections(value: unknown): PayloadResult<OrderListExclusionSelection[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'exclusionsは配列で指定してください' };
  if (value.length > MAX_CONFIRM_SELECTIONS) {
    return { ok: false, error: `一度に除外できる件数は${MAX_CONFIRM_SELECTIONS}件までです` };
  }

  const seenItemIds = new Set<string>();
  const exclusions: OrderListExclusionSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'exclusionsの各要素は商品IDで指定してください' };
    }
    const itemId = (entry as { item_id?: unknown }).item_id;
    if (typeof itemId !== 'string' || !itemId.trim()) {
      return { ok: false, error: '除外する商品のitem_idは必須です' };
    }
    if (seenItemIds.has(itemId)) {
      return { ok: false, error: `同じitem_idが重複しています: ${itemId}` };
    }
    seenItemIds.add(itemId);
    exclusions.push({ item_id: itemId });
  }
  return { ok: true, value: exclusions };
}

function optionalText(value: unknown, field: string, maxLength: number): PayloadResult<string> {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: `${field}は文字列で指定してください` };
  const normalized = value.trim();
  if (normalized.length > maxLength) return { ok: false, error: `${field}は${maxLength}文字以内で指定してください` };
  return { ok: true, value: normalized };
}

function optionalImageUrl(value: unknown, field: string): PayloadResult<string | null> {
  const parsed = optionalText(value, field, 2048);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: true, value: null };
  try {
    const url = new URL(parsed.value);
    if (url.protocol !== 'https:'
      || (url.port && url.port !== '443')
      || !allowedNewCardImageHosts.has(url.hostname.toLowerCase())) {
      throw new Error('unsupported image host');
    }
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, error: `${field}は許可された画像ホストのhttps URLで指定してください` };
  }
}

export function parseOrderListNewCardSelections(value: unknown): PayloadResult<OrderListNewCardSelection[]> {
  if (!Array.isArray(value)) return { ok: false, error: 'new_cardsは配列で指定してください' };
  if (value.length > MAX_CONFIRM_SELECTIONS) {
    return { ok: false, error: `一度に新規登録できる件数は${MAX_CONFIRM_SELECTIONS}件までです` };
  }

  const seenItemIds = new Set<string>();
  const newCards: OrderListNewCardSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'new_cardsの各要素は商品情報として指定してください' };
    }
    const raw = entry as Record<string, unknown>;
    const itemId = typeof raw.item_id === 'string' ? raw.item_id.trim() : '';
    if (!itemId) return { ok: false, error: '新規商品のitem_idは必須です' };
    if (seenItemIds.has(itemId)) return { ok: false, error: `同じitem_idが重複しています: ${itemId}` };

    const cardName = optionalText(raw.card_name, '商品名', 300);
    const grade = optionalText(raw.grade, 'グレード・種別', 100);
    const listNo = optionalText(raw.list_no, 'リスト番号', 100);
    const tag = optionalText(raw.tag, 'タグ', 200);
    const altImageUrl = optionalImageUrl(raw.alt_image_url, '代替画像URL');
    const invalid = [cardName, grade, listNo, tag, altImageUrl].find((result) => !result.ok);
    if (invalid && !invalid.ok) {
      return { ok: false, error: `新規商品 ${itemId}: ${invalid.error}` };
    }
    if (!cardName.ok || !grade.ok || !listNo.ok || !tag.ok || !altImageUrl.ok) {
      return { ok: false, error: '新規商品情報の形式が正しくありません' };
    }
    if (!cardName.value) return { ok: false, error: '新規商品の商品名は必須です' };
    if (!tag.value) return { ok: false, error: '新規商品のタグは必須です' };

    seenItemIds.add(itemId);
    newCards.push({
      item_id: itemId,
      card_name: cardName.value,
      grade: grade.value,
      list_no: listNo.value,
      tag: tag.value,
      alt_image_url: altImageUrl.value,
    });
  }
  return { ok: true, value: newCards };
}

export function parseOrderListSelectionsPayload(value: unknown): PayloadResult<OrderListSelectionsPayload> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '対応内容の形式が正しくありません' };
  }
  const payload = value as { mappings?: unknown; new_cards?: unknown; exclusions?: unknown };
  const mappings = parseOrderListMappingSelections(payload.mappings ?? []);
  if (!mappings.ok) return mappings;
  const newCards = parseOrderListNewCardSelections(payload.new_cards ?? []);
  if (!newCards.ok) return newCards;
  const exclusions = parseOrderListExclusionSelections(payload.exclusions ?? []);
  if (!exclusions.ok) return exclusions;
  const totalSelections = mappings.value.length + newCards.value.length + exclusions.value.length;
  if (totalSelections > MAX_CONFIRM_SELECTIONS) {
    return { ok: false, error: `一度に確定できる件数は${MAX_CONFIRM_SELECTIONS}件までです` };
  }

  const selectedItemIds = new Set<string>();
  for (const selection of mappings.value) selectedItemIds.add(selection.item_id);
  for (const selection of newCards.value) {
    if (selectedItemIds.has(selection.item_id)) {
      return { ok: false, error: `同じitem_idを複数の処理に指定できません: ${selection.item_id}` };
    }
    selectedItemIds.add(selection.item_id);
  }
  for (const exclusion of exclusions.value) {
    if (selectedItemIds.has(exclusion.item_id)) {
      return { ok: false, error: `同じitem_idを複数の処理に指定できません: ${exclusion.item_id}` };
    }
    selectedItemIds.add(exclusion.item_id);
  }

  return {
    ok: true,
    value: {
      mappings: mappings.value,
      newCards: newCards.value,
      exclusions: exclusions.value,
    },
  };
}

export function parseOrderListConfirmPayload(value: unknown): PayloadResult<OrderListConfirmPayload> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '確認内容の形式が正しくありません' };
  }
  const payload = value as { mappings?: unknown; new_cards?: unknown; allow_unresolved?: unknown };
  const selections = parseOrderListSelectionsPayload(payload);
  if (!selections.ok) return selections;
  if (payload.allow_unresolved !== undefined && typeof payload.allow_unresolved !== 'boolean') {
    return { ok: false, error: 'allow_unresolvedは真偽値で指定してください' };
  }
  return {
    ok: true,
    value: {
      mappings: selections.value.mappings,
      newCards: selections.value.newCards,
      exclusions: selections.value.exclusions,
      allowUnresolved: payload.allow_unresolved === true,
    },
  };
}

export function orderListSyncRequestFingerprint(payload: OrderListConfirmPayload): string {
  const byItemId = <T extends { item_id: string }>(left: T, right: T) =>
    left.item_id.localeCompare(right.item_id);
  const normalized = {
    mappings: [...payload.mappings].sort(byItemId).map((entry) => ({
      item_id: entry.item_id,
      db_card_id: entry.db_card_id,
    })),
    new_cards: [...payload.newCards].sort(byItemId).map((entry) => ({
      item_id: entry.item_id,
      card_name: entry.card_name,
      grade: entry.grade,
      list_no: entry.list_no,
      tag: entry.tag,
      alt_image_url: entry.alt_image_url,
    })),
    exclusions: [...payload.exclusions].sort(byItemId).map((entry) => ({ item_id: entry.item_id })),
    allow_unresolved: payload.allowUnresolved,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function parseOrderListResyncPayload(value: unknown): PayloadResult<OrderListResyncPayload> {
  const confirmation = parseOrderListConfirmPayload(value);
  if (!confirmation.ok) return confirmation;
  const requestId = (value as { request_id?: unknown }).request_id;
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId.trim())) {
    return { ok: false, error: 'request_idはUUIDで指定してください' };
  }
  return { ok: true, value: { ...confirmation.value, requestId: requestId.trim() } };
}

type FranchiseSummary = {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  excluded: number;
  invalid: number;
};

type ImportSummary = FranchiseSummary & {
  by_franchise: Record<Franchise, FranchiseSummary>;
};

function emptyCounts(): FranchiseSummary {
  return { total: 0, matched: 0, ambiguous: 0, unmatched: 0, excluded: 0, invalid: 0 };
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
    excluded: row.excluded_rows,
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
  store: string;
  franchise: string;
  source_product_id: string;
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
      store: STORE_NAME,
      franchise,
      source_product_id: '',
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
        { onConflict: 'store,franchise,card_name,grade,list_no,source_product_id' },
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
      .eq('store', STORE_NAME)
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
      .eq('store', STORE_NAME)
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
      store: STORE_NAME,
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
        onConflict: 'store,franchise,excel_product_key',
        ignoreDuplicates: true,
      });
    if (error) throw new Error('Excel商品対応表保存失敗: ' + error.message);
  }

  const allMappings: ExcelProductMappingRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('excel_product_mapping')
      .select('*')
      .eq('store', STORE_NAME)
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
      .eq('store', STORE_NAME)
      .select('*')
      .single<ExcelProductMappingRow>();
    if (error || !data) {
      throw new Error('Excel商品対応表の再照合保存失敗: ' + (error?.message ?? 'unknown'));
    }
    byKey.set(key, data);
  }

  const seenIds = new Set<string>();
  for (const result of results) {
    if (result.status !== 'matched' && result.status !== 'excluded') continue;
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
      .in('id', ids.slice(i, i + 200))
      .eq('store', STORE_NAME);
    if (error) throw new Error('Excel商品対応表の最終確認日更新失敗: ' + error.message);
  }

  return new Map(
    [...byKey].filter(([, mapping]) => mapping.status === 'active'),
  );
}

orderListImportRoutes.get('/order-list/runs/:id/csv', async (c) => {
  const runId = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: scopedRun, error: scopedRunError } = await supabase
    .from('run')
    .select('id')
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'データがありません' }, 404);

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
      .eq('store', STORE_NAME)
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
    .order('business_date', { ascending: false })
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
  const page = Math.max(Number(c.req.query('page') || 1), 1);
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 100), 1), 200);
  const status = c.req.query('status');
  const from = (page - 1) * limit;

  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id')
    .eq('id', c.req.param('id'))
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  let query = supabase
    .from('order_list_item')
    .select('*', { count: 'exact' })
    .eq('import_id', c.req.param('id'));
  if (status && ['matched', 'ambiguous', 'unmatched', 'excluded', 'invalid'].includes(status)) {
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

  // The same workbook may need to be parsed again when the parser contract
  // changes (for example, v1 ignored newly supported franchise sheets).
  const { data: duplicate, error: duplicateError } = await findCurrentParserDuplicate(
    supabase,
    businessDate,
    sha256,
  );
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
        .eq('last_seen_import_id', duplicate.id)
        .eq('store', STORE_NAME);
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
      valid_rows: summary.matched + summary.ambiguous + summary.unmatched + summary.excluded,
      matched_rows: summary.matched,
      unmatched_rows: summary.unmatched,
      ambiguous_rows: summary.ambiguous,
      excluded_rows: summary.excluded,
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

  // Resolver RPCs are service-role-only, and the batch resolver is reused by
  // atomic confirm. Enforce post-apply editing at this HTTP trust boundary so
  // parsed/failed imports can only persist staged choices through confirm.
  const { data: importState, error: importStateError } = await supabase
    .from('order_list_import')
    .select('status')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (importStateError) return c.json({ error: importStateError.message }, 500);
  if (!importState) return c.json({ error: 'order_list_import was not found' }, 404);
  if (!canEditOrderListMappings(importState.status)) {
    return c.json({ error: 'Individual mapping edits are available only after apply' }, 409);
  }
  const { data, error } = await supabase.rpc('resolve_order_list_review_changes', {
    p_import_id: importId,
    p_mappings: [{ item_id: itemId, db_card_id: payload.db_card_id }],
    p_new_cards: [],
    p_exclusions: [],
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

async function respondToOrderListSyncClaim(
  c: Context,
  supabase: SupabaseClient<Database>,
  importId: string,
  data: unknown,
  syncRequest?: { requestId: string; requestFingerprint: string },
) {
  const confirmation = (data ?? {}) as Record<string, unknown>;
  const action = confirmation.action;
  const created = typeof confirmation.created === 'number' ? confirmation.created : 0;
  const reused = typeof confirmation.reused === 'number' ? confirmation.reused : 0;
  const resolved = typeof confirmation.resolved === 'number' ? confirmation.resolved : 0;
  const excluded = typeof confirmation.excluded === 'number' ? confirmation.excluded : 0;
  const unselected = typeof confirmation.unselected === 'number' ? confirmation.unselected : 0;
  const invalid = typeof confirmation.invalid === 'number' ? confirmation.invalid : 0;
  const status = typeof confirmation.status === 'string' ? confirmation.status : 'confirmed';
  const runId = typeof confirmation.run_id === 'string' ? confirmation.run_id : undefined;
  const runStatus = typeof confirmation.run_status === 'string' ? confirmation.run_status : undefined;
  const launchClaimedAt = typeof confirmation.launch_claimed_at === 'string'
    ? confirmation.launch_claimed_at
    : undefined;
  const syncRequestId = typeof confirmation.request_id === 'string'
    ? confirmation.request_id
    : syncRequest?.requestId;
  const syncRequestFingerprint = syncRequest?.requestFingerprint;

  if (action === 'noop') {
    return c.json({
      import_id: importId,
      status,
      sync_started: false,
      ...(runId ? { run_id: runId } : {}),
      ...(runStatus ? { run_status: runStatus } : {}),
      ...(syncRequestId ? { request_id: syncRequestId } : {}),
      launch_pending: confirmation.launch_pending === true,
      created,
      reused,
      resolved,
      excluded,
      unselected,
      invalid,
    });
  }
  if (action !== 'start_job' || !launchClaimedAt) {
    return c.json({ error: '取込確認の状態が正しくありません' }, 500);
  }

  try {
    const job = await executeCloudRunJob(ORDER_LIST_SYNC_JOB_NAME, {
      env: {
        ORDER_LIST_IMPORT_ID: importId,
        STORE_NAME,
        ...(syncRequestId ? { ORDER_LIST_SYNC_REQUEST_ID: syncRequestId } : {}),
        ...(syncRequestFingerprint
          ? { ORDER_LIST_SYNC_REQUEST_FINGERPRINT: syncRequestFingerprint }
          : {}),
        TRIGGER: 'web-ui',
      },
    });
    return c.json({
      import_id: importId,
      status: 'confirmed',
      sync_started: true,
      ...(syncRequestId ? { request_id: syncRequestId } : {}),
      created,
      reused,
      resolved,
      excluded,
      unselected,
      invalid,
      job: {
        operation: job.operationName,
        execution: job.executionName,
      },
    });
  } catch (jobError) {
    const definitiveRejection = isDefinitiveCloudRunJobRejection(jobError);
    let claimReleased = false;
    let releaseErrorMessage: string | null = null;
    if (definitiveRejection) {
      const { data: releasedClaim, error: releaseError } = await supabase
        .from('order_list_import')
        .update({
          heartbeat_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', importId)
        .eq('store', STORE_NAME)
        .eq('status', 'confirmed')
        .eq('heartbeat_at', launchClaimedAt)
        .select('id')
        .maybeSingle();
      claimReleased = Boolean(releasedClaim) && !releaseError;
      releaseErrorMessage = releaseError?.message ?? null;
    }

    return c.json({
      error: definitiveRejection
        ? claimReleased
          ? '商品対応・除外設定は保存済みですが、同期ジョブは開始されませんでした。もう一度同期を押してください'
          : '商品対応・除外設定は保存済みです。同期の状態が変わったため、画面を更新して確認してください'
        : '商品対応・除外設定は保存済みですが、同期ジョブの起動結果を確認できませんでした。二重起動防止のため5分後に再試行してください',
      detail: jobError instanceof Error ? jobError.message : String(jobError),
      confirmation_saved: true,
      launch_pending: !definitiveRejection,
      retryable: claimReleased,
      ...(!definitiveRejection ? { retry_after_seconds: 300 } : {}),
      ...(releaseErrorMessage ? { state_error: '再試行状態の保存に失敗しました: ' + releaseErrorMessage } : {}),
    }, 502);
  }
}

function orderListRpcErrorStatus(code: string | undefined): 404 | 409 | 422 | 500 {
  if (code === 'P0002') return 404;
  if (code === '22023') return 422;
  if (code === '55000' || code === '23505' || code === '40001') return 409;
  return 500;
}

orderListImportRoutes.patch('/order-list/imports/:id/mappings', async (c) => {
  const importId = c.req.param('id');
  const payload = await c.req.json<unknown>().catch(() => null);
  const parsed = parseOrderListSelectionsPayload(payload);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (
    parsed.value.mappings.length
      + parsed.value.newCards.length
      + parsed.value.exclusions.length === 0
  ) {
    return c.json({ error: '保存する対応付け・新規商品・除外設定を1件以上選択してください' }, 400);
  }

  const supabase = createSupabaseClient();

  // parsed/failed choices are confirm-only. Applied imports may save review
  // changes for the next import without immediately starting a sync.
  const { data: importState, error: importStateError } = await supabase
    .from('order_list_import')
    .select('status')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (importStateError) return c.json({ error: importStateError.message }, 500);
  if (!importState) return c.json({ error: 'order_list_import was not found' }, 404);
  if (!canEditOrderListMappings(importState.status)) {
    return c.json({ error: 'Batch mapping edits are available only after apply' }, 409);
  }

  const { data, error } = await supabase.rpc('resolve_order_list_review_changes', {
    p_import_id: importId,
    p_mappings: parsed.value.mappings,
    p_new_cards: parsed.value.newCards,
    p_exclusions: parsed.value.exclusions,
    p_allow_unresolved: true,
  });
  if (error) return c.json({ error: error.message }, orderListRpcErrorStatus(error.code));
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
  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id, business_date, created_at')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle<OrderListImportRecencyTarget>();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  const newerImportGuard = await guardAgainstNewerOrderListImport(supabase, scopedImport);
  if (!newerImportGuard.ok) {
    return c.json(newerImportGuard.body, newerImportGuard.status);
  }

  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { error: staleRecoveryError } = await supabase.rpc('recover_stale_order_list_imports_for_store', {
    p_store: STORE_NAME,
    p_stale_before: staleBefore,
  });
  if (staleRecoveryError) return c.json({ error: staleRecoveryError.message }, 500);

  const { data, error } = await supabase.rpc('confirm_order_list_import_review', {
    p_import_id: importId,
    p_mappings: confirmPayload.mappings,
    p_new_cards: confirmPayload.newCards,
    p_exclusions: confirmPayload.exclusions,
    p_allow_unresolved: confirmPayload.allowUnresolved,
  });
  if (error) return c.json({ error: error.message }, orderListRpcErrorStatus(error.code));
  return respondToOrderListSyncClaim(c, supabase, importId, data);
});

orderListImportRoutes.post('/order-list/imports/:id/resync', async (c) => {
  const importId = c.req.param('id');
  let rawPayload: unknown = {};
  if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    try {
      rawPayload = await c.req.json<unknown>();
    } catch {
      return c.json({ error: '同期内容のJSONが正しくありません' }, 400);
    }
  }
  const parsedPayload = parseOrderListResyncPayload(rawPayload);
  if (!parsedPayload.ok) return c.json({ error: parsedPayload.error }, 400);
  const syncPayload = parsedPayload.value;
  const requestFingerprint = orderListSyncRequestFingerprint(syncPayload);

  const supabase = createSupabaseClient();
  const { data: scopedImport, error: scopedImportError } = await supabase
    .from('order_list_import')
    .select('id, business_date, created_at')
    .eq('id', importId)
    .eq('store', STORE_NAME)
    .maybeSingle<OrderListImportRecencyTarget>();
  if (scopedImportError) return c.json({ error: scopedImportError.message }, 500);
  if (!scopedImport) return c.json({ error: 'オーダーリスト取込が見つかりません' }, 404);

  const newerImportGuard = await guardAgainstNewerOrderListImport(supabase, scopedImport);
  if (!newerImportGuard.ok) {
    return c.json(newerImportGuard.body, newerImportGuard.status);
  }

  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { error: staleRecoveryError } = await supabase.rpc('recover_stale_order_list_imports_for_store', {
    p_store: STORE_NAME,
    p_stale_before: staleBefore,
  });
  if (staleRecoveryError) return c.json({ error: staleRecoveryError.message }, 500);

  const { data, error } = await supabase.rpc('queue_order_list_import_resync', {
    p_import_id: importId,
    p_mappings: syncPayload.mappings,
    p_new_cards: syncPayload.newCards,
    p_exclusions: syncPayload.exclusions,
    p_allow_unresolved: syncPayload.allowUnresolved,
    p_request_id: syncPayload.requestId,
    p_request_fingerprint: requestFingerprint,
  });
  if (error) return c.json({ error: error.message }, orderListRpcErrorStatus(error.code));
  return respondToOrderListSyncClaim(c, supabase, importId, data, {
    requestId: syncPayload.requestId,
    requestFingerprint,
  });
});
