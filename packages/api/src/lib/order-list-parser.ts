import type { Franchise } from '@haraka/shared';
import ExcelJS from 'exceljs';
import type { Cell, CellValue, Row, Worksheet } from 'exceljs';

export const ORDER_LIST_MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
export const ORDER_LIST_MAX_DATA_ROWS = 12_000;
export const ORDER_LIST_ALLOWED_IMAGE_HOSTS = [
  'fexadnveyuqduiujewrc.supabase.co',
  'firebasestorage.googleapis.com',
] as const;


export const ORDER_LIST_REQUIRED_HEADERS = [
  '商品ID',
  '名称',
  '種別',
  'エキスパンション',
  'リスト番号',
  'レアリティ',
  '画像',
  '募集数',
  '納品希望価格(税込)',
] as const;

export type OrderListRequiredHeader = typeof ORDER_LIST_REQUIRED_HEADERS[number];

export const ORDER_LIST_SHEETS = [
  { sheetName: 'ポケモン', franchise: 'Pokemon' },
  { sheetName: 'ワンピース', franchise: 'ONE PIECE' },
  { sheetName: '遊戯王', franchise: 'YU-GI-OH!' },
] as const satisfies ReadonlyArray<{ sheetName: string; franchise: Franchise }>;

export type OrderListIssueSeverity = 'error' | 'warning';
export type OrderListIssueCode =
  | 'empty_workbook'
  | 'workbook_too_large'
  | 'workbook_too_many_rows'
  | 'workbook_read_failed'
  | 'missing_sheet'
  | 'header_row_not_found'
  | 'ambiguous_header_row'
  | 'missing_required_headers'
  | 'duplicate_required_header'
  | 'empty_sheet'
  | 'missing_product_id'
  | 'missing_card_name'
  | 'missing_grade'
  | 'missing_list_no'
  | 'missing_image_url'
  | 'invalid_image_url'
  | 'missing_demand'
  | 'invalid_demand'
  | 'missing_source_price'
  | 'invalid_source_price'
  | 'duplicate_product_id';

export type OrderListIssueLocation = {
  sheetName: string;
  rowNumber: number;
};

export type OrderListParseIssue = {
  severity: OrderListIssueSeverity;
  code: OrderListIssueCode;
  message: string;
  sheetName?: string;
  rowNumber?: number;
  field?: string;
  value?: string;
  relatedRows?: OrderListIssueLocation[];
};

export type OrderListRawCellValue =
  | string
  | number
  | boolean
  | null
  | OrderListRawCellValue[]
  | { [key: string]: OrderListRawCellValue };

export type OrderListRow = {
  franchise: Franchise;
  excelProductId: string;
  cardName: string;
  grade: string | null;
  expansion: string | null;
  listNo: string | null;
  rarity: string | null;
  imageUrl: string | null;
  demand: number | null;
  sourcePrice: number | null;
  sheetName: string;
  sheetRowNumber: number;
  rawRow: Record<string, OrderListRawCellValue>;
  validationIssues: OrderListParseIssue[];
  valid: boolean;
};

export type OrderListSheetSummary = {
  sheetName: string;
  franchise: Franchise;
  found: boolean;
  headerRowNumber: number | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  warningRows: number;
  duplicateRows: number;
};

export type OrderListParseSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  structuralErrorCount: number;
  errorCount: number;
  warningCount: number;
  sheets: OrderListSheetSummary[];
};

export type OrderListParseResult = {
  // All structural and row validations passed.
  valid: boolean;
  // The workbook and all three required sheets/headers can be trusted.
  structuralValid: boolean;
  rows: OrderListRow[];
  issues: OrderListParseIssue[];
  summary: OrderListParseSummary;
};

type HeaderInfo = {
  rowNumber: number;
  columnByHeader: Map<OrderListRequiredHeader, number>;
  rawHeaderByColumn: Map<number, string>;
  maxColumn: number;
};

type ParsedNumber = {
  value: number | null;
  present: boolean;
  valid: boolean;
};

type SheetMetadata = {
  found: boolean;
  headerRowNumber: number | null;
};

const normalizedRequiredHeader = new Map<string, OrderListRequiredHeader>(
  ORDER_LIST_REQUIRED_HEADERS.map((header) => [normalizeHeader(header), header])
);

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]+/g, '').trim();
}

function normalizeString(value: string): string {
  return value.normalize('NFC').replace(/\u00a0/g, ' ').trim();
}

function getCellText(cell: Cell): string {
  return normalizeString(cell.text ?? '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getFormulaResult(value: CellValue): unknown {
  return isObject(value) && 'result' in value ? value.result : value;
}

function toJsonSafeValue(value: unknown, depth = 0): OrderListRawCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= 5) return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafeValue(item, depth + 1));
  }
  if (isObject(value)) {
    const result: Record<string, OrderListRawCellValue> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) {
        result[key] = toJsonSafeValue(nestedValue, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function parseNumberCell(cell: Cell): ParsedNumber {
  const rawValue = getFormulaResult(cell.value);
  if (typeof rawValue === 'number') {
    const valid = Number.isFinite(rawValue);
    return { value: valid ? rawValue : null, present: true, valid };
  }

  const text = getCellText(cell);
  if (!text) return { value: null, present: false, valid: true };

  const cleaned = text
    .normalize('NFKC')
    .replace(/[\u00a0\s,\u3001¥￥$]/g, '')
    .replace(/円$/u, '');
  const value = Number(cleaned);
  const valid = cleaned.length > 0 && Number.isFinite(value);
  return { value: valid ? value : null, present: true, valid };
}

function extractFormulaUrl(formula: string): string | null {
  const match = formula.match(/(?:HYPERLINK|IMAGE)\s*\(\s*"((?:""|[^"])*)"/iu);
  return match ? match[1].replace(/""/g, '"') : null;
}

const allowedImageHosts = new Set<string>([
  ...ORDER_LIST_ALLOWED_IMAGE_HOSTS,
  ...(process.env.ORDER_LIST_IMAGE_HOST_ALLOWLIST ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
]);

function normalizeHttpUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate.trim());
    if (url.protocol !== 'https:' || !allowedImageHosts.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseImageUrl(
  cell: Cell
): { value: string | null; present: boolean; valid: boolean; rawText: string } {
  const rawValue = cell.value;
  const candidates: string[] = [];

  if (cell.hyperlink) candidates.push(cell.hyperlink);
  if (isObject(rawValue)) {
    if (typeof rawValue.hyperlink === 'string') candidates.push(rawValue.hyperlink);
    if (typeof rawValue.formula === 'string') {
      const formulaUrl = extractFormulaUrl(rawValue.formula);
      if (formulaUrl) candidates.push(formulaUrl);
    }
  }

  const rawText = getCellText(cell);
  if (rawText) candidates.push(rawText);
  const uniqueCandidates = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];

  for (const candidate of uniqueCandidates) {
    const url = normalizeHttpUrl(candidate);
    if (url) return { value: url, present: true, valid: true, rawText };
  }

  return {
    value: null,
    present: uniqueCandidates.length > 0,
    valid: uniqueCandidates.length === 0,
    rawText,
  };
}

function makeIssue(
  severity: OrderListIssueSeverity,
  code: OrderListIssueCode,
  message: string,
  details: Omit<OrderListParseIssue, 'severity' | 'code' | 'message'> = {}
): OrderListParseIssue {
  return { severity, code, message, ...details };
}

function detectHeaderRow(
  worksheet: Worksheet
): { headerInfo: HeaderInfo | null; issues: OrderListParseIssue[] } {
  const issues: OrderListParseIssue[] = [];
  const candidates: Array<{
    rowNumber: number;
    columnByHeader: Map<OrderListRequiredHeader, number>;
    rawHeaderByColumn: Map<number, string>;
    duplicateHeaders: OrderListRequiredHeader[];
    maxColumn: number;
  }> = [];

  const lastCandidateRow = Math.min(worksheet.actualRowCount, 25);
  for (let rowNumber = 1; rowNumber <= lastCandidateRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const maxColumn = Math.max(row.cellCount, worksheet.actualColumnCount);
    const columnByHeader = new Map<OrderListRequiredHeader, number>();
    const rawHeaderByColumn = new Map<number, string>();
    const duplicateHeaders = new Set<OrderListRequiredHeader>();

    for (let columnNumber = 1; columnNumber <= maxColumn; columnNumber += 1) {
      const rawHeader = getCellText(row.getCell(columnNumber));
      rawHeaderByColumn.set(columnNumber, rawHeader);
      const requiredHeader = normalizedRequiredHeader.get(normalizeHeader(rawHeader));
      if (!requiredHeader) continue;
      if (columnByHeader.has(requiredHeader)) duplicateHeaders.add(requiredHeader);
      else columnByHeader.set(requiredHeader, columnNumber);
    }

    if (columnByHeader.size > 0) {
      candidates.push({
        rowNumber,
        columnByHeader,
        rawHeaderByColumn,
        duplicateHeaders: [...duplicateHeaders],
        maxColumn,
      });
    }
  }

  if (candidates.length === 0) {
    issues.push(makeIssue('error', 'header_row_not_found', '必須ヘッダー行を見つけられません。', {
      sheetName: worksheet.name,
    }));
    return { headerInfo: null, issues };
  }

  const bestMatchCount = Math.max(...candidates.map((candidate) => candidate.columnByHeader.size));
  const bestCandidates = candidates.filter((candidate) => candidate.columnByHeader.size === bestMatchCount);
  const selected = bestCandidates[0];

  if (bestCandidates.length > 1 && bestMatchCount === ORDER_LIST_REQUIRED_HEADERS.length) {
    issues.push(makeIssue(
      'error',
      'ambiguous_header_row',
      '必須ヘッダーが揃った行が複数あるため、ヘッダー行を特定できません。',
      {
        sheetName: worksheet.name,
        relatedRows: bestCandidates.map((candidate) => ({
          sheetName: worksheet.name,
          rowNumber: candidate.rowNumber,
        })),
      }
    ));
  }

  const missingHeaders = ORDER_LIST_REQUIRED_HEADERS.filter(
    (header) => !selected.columnByHeader.has(header)
  );
  if (missingHeaders.length > 0) {
    issues.push(makeIssue(
      'error',
      'missing_required_headers',
      '必須列が不足しています: ' + missingHeaders.join(', '),
      {
        sheetName: worksheet.name,
        rowNumber: selected.rowNumber,
        value: missingHeaders.join(','),
      }
    ));
  }

  for (const duplicateHeader of selected.duplicateHeaders) {
    issues.push(makeIssue(
      'error',
      'duplicate_required_header',
      '必須列「' + duplicateHeader + '」が複数あります。',
      {
        sheetName: worksheet.name,
        rowNumber: selected.rowNumber,
        field: duplicateHeader,
      }
    ));
  }

  if (issues.some((item) => item.severity === 'error')) {
    return { headerInfo: null, issues };
  }

  return {
    headerInfo: {
      rowNumber: selected.rowNumber,
      columnByHeader: selected.columnByHeader,
      rawHeaderByColumn: selected.rawHeaderByColumn,
      maxColumn: Math.max(selected.maxColumn, worksheet.actualColumnCount),
    },
    issues,
  };
}

function isDataRowEmpty(row: Row, maxColumn: number): boolean {
  for (let columnNumber = 1; columnNumber <= maxColumn; columnNumber += 1) {
    const cell = row.getCell(columnNumber);
    if (cell.value !== null && cell.value !== undefined && getCellText(cell) !== '') return false;
  }
  return true;
}

function buildRawRow(row: Row, headerInfo: HeaderInfo): Record<string, OrderListRawCellValue> {
  const rawRow: Record<string, OrderListRawCellValue> = {};
  const keyCounts = new Map<string, number>();
  const maxColumn = Math.max(headerInfo.maxColumn, row.cellCount);

  for (let columnNumber = 1; columnNumber <= maxColumn; columnNumber += 1) {
    const header = headerInfo.rawHeaderByColumn.get(columnNumber) || '__column_' + columnNumber;
    const count = (keyCounts.get(header) ?? 0) + 1;
    keyCounts.set(header, count);
    const key = count === 1 ? header : header + '#' + count;
    rawRow[key] = toJsonSafeValue(row.getCell(columnNumber).value);
  }

  return rawRow;
}

function parseSheetRows(
  worksheet: Worksheet,
  franchise: Franchise,
  headerInfo: HeaderInfo
): OrderListRow[] {
  const rows: OrderListRow[] = [];
  const column = (header: OrderListRequiredHeader): number => {
    const columnNumber = headerInfo.columnByHeader.get(header);
    if (columnNumber === undefined) throw new Error('Missing validated header: ' + header);
    return columnNumber;
  };

  for (
    let rowNumber = headerInfo.rowNumber + 1;
    rowNumber <= worksheet.actualRowCount;
    rowNumber += 1
  ) {
    const sourceRow = worksheet.getRow(rowNumber);
    if (isDataRowEmpty(sourceRow, headerInfo.maxColumn)) continue;

    const validationIssues: OrderListParseIssue[] = [];
    const location = { sheetName: worksheet.name, rowNumber };
    const excelProductId = getCellText(sourceRow.getCell(column('商品ID')));
    const cardName = getCellText(sourceRow.getCell(column('名称')));
    const grade = getCellText(sourceRow.getCell(column('種別'))) || null;
    const expansion = getCellText(sourceRow.getCell(column('エキスパンション'))) || null;
    const listNo = getCellText(sourceRow.getCell(column('リスト番号'))) || null;
    const rarity = getCellText(sourceRow.getCell(column('レアリティ'))) || null;
    const image = parseImageUrl(sourceRow.getCell(column('画像')));
    const demand = parseNumberCell(sourceRow.getCell(column('募集数')));
    const sourcePrice = parseNumberCell(sourceRow.getCell(column('納品希望価格(税込)')));

    if (!excelProductId) {
      validationIssues.push(makeIssue('error', 'missing_product_id', '商品IDが空です。', {
        ...location,
        field: '商品ID',
      }));
    }
    if (!cardName) {
      validationIssues.push(makeIssue('error', 'missing_card_name', '名称が空です。', {
        ...location,
        field: '名称',
      }));
    }
    if (!grade) {
      validationIssues.push(makeIssue(
        'warning',
        'missing_grade',
        '種別が空です。DB自動照合の精度が下がります。',
        { ...location, field: '種別' }
      ));
    }
    if (!listNo) {
      validationIssues.push(makeIssue(
        'warning',
        'missing_list_no',
        'リスト番号が空です。DB自動照合の精度が下がります。',
        { ...location, field: 'リスト番号' }
      ));
    }
    if (!image.present) {
      validationIssues.push(makeIssue(
        'warning',
        'missing_image_url',
        '画像URLが空です。DBの代替URLが必要です。',
        { ...location, field: '画像' }
      ));
    } else if (!image.valid) {
      validationIssues.push(makeIssue(
        'warning',
        'invalid_image_url',
        '画像列が許可済みHTTPS URLではありません。DBの代替URLを使用します。',
        { ...location, field: '画像', value: image.rawText }
      ));
    }
    if (!demand.present) {
      validationIssues.push(makeIssue('warning', 'missing_demand', '募集数が空です。', {
        ...location,
        field: '募集数',
      }));
    } else if (
      !demand.valid ||
      demand.value === null ||
      !Number.isInteger(demand.value) ||
      demand.value < 0
    ) {
      validationIssues.push(makeIssue(
        'error',
        'invalid_demand',
        '募集数は0以上の整数で指定してください。',
        {
          ...location,
          field: '募集数',
          value: getCellText(sourceRow.getCell(column('募集数'))),
        }
      ));
    }
    if (!sourcePrice.present) {
      validationIssues.push(makeIssue(
        'error',
        'missing_source_price',
        '納品希望価格(税込)が空です。',
        { ...location, field: '納品希望価格(税込)' }
      ));
    } else if (!sourcePrice.valid || sourcePrice.value === null || sourcePrice.value < 0) {
      validationIssues.push(makeIssue(
        'error',
        'invalid_source_price',
        '納品希望価格(税込)は0以上の数値で指定してください。',
        {
          ...location,
          field: '納品希望価格(税込)',
          value: getCellText(sourceRow.getCell(column('納品希望価格(税込)'))),
        }
      ));
    }

    rows.push({
      franchise,
      excelProductId,
      cardName,
      grade,
      expansion,
      listNo,
      rarity,
      imageUrl: image.value,
      demand: demand.valid ? demand.value : null,
      sourcePrice: sourcePrice.valid ? sourcePrice.value : null,
      sheetName: worksheet.name,
      sheetRowNumber: rowNumber,
      rawRow: buildRawRow(sourceRow, headerInfo),
      validationIssues,
      valid: !validationIssues.some((item) => item.severity === 'error'),
    });
  }

  return rows;
}

function addDuplicateIssues(rows: OrderListRow[]): void {
  const rowsByProductId = new Map<string, OrderListRow[]>();

  for (const row of rows) {
    if (!row.excelProductId) continue;
    const normalizedProductId = row.excelProductId.normalize('NFKC').trim()
      .replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
    const key = row.franchise + '\u0000' + normalizedProductId;
    const group = rowsByProductId.get(key);
    if (group) group.push(row);
    else rowsByProductId.set(key, [row]);
  }

  for (const duplicateRows of rowsByProductId.values()) {
    if (duplicateRows.length < 2) continue;
    const relatedRows = duplicateRows.map((row) => ({
      sheetName: row.sheetName,
      rowNumber: row.sheetRowNumber,
    }));

    for (const row of duplicateRows) {
      row.validationIssues.push(makeIssue(
        'error',
        'duplicate_product_id',
        '同じ商材内で商品ID「' + row.excelProductId + '」が重複しています。',
        {
          sheetName: row.sheetName,
          rowNumber: row.sheetRowNumber,
          field: '商品ID',
          value: row.excelProductId,
          relatedRows,
        }
      ));
      row.valid = false;
    }
  }
}

function buildSummary(
  rows: OrderListRow[],
  issues: OrderListParseIssue[],
  structuralIssues: OrderListParseIssue[],
  sheetMetadata: Map<string, SheetMetadata>
): OrderListParseSummary {
  const sheets = ORDER_LIST_SHEETS.map(({ sheetName, franchise }) => {
    const sheetRows = rows.filter((row) => row.sheetName === sheetName);
    return {
      sheetName,
      franchise,
      found: sheetMetadata.get(sheetName)?.found ?? false,
      headerRowNumber: sheetMetadata.get(sheetName)?.headerRowNumber ?? null,
      totalRows: sheetRows.length,
      validRows: sheetRows.filter((row) => row.valid).length,
      invalidRows: sheetRows.filter((row) => !row.valid).length,
      warningRows: sheetRows.filter((row) =>
        row.validationIssues.some((item) => item.severity === 'warning')
      ).length,
      duplicateRows: sheetRows.filter((row) =>
        row.validationIssues.some((item) => item.code === 'duplicate_product_id')
      ).length,
    } satisfies OrderListSheetSummary;
  });

  return {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.valid).length,
    invalidRows: rows.filter((row) => !row.valid).length,
    duplicateRows: rows.filter((row) =>
      row.validationIssues.some((item) => item.code === 'duplicate_product_id')
    ).length,
    structuralErrorCount: structuralIssues.filter((item) => item.severity === 'error').length,
    errorCount: issues.filter((item) => item.severity === 'error').length,
    warningCount: issues.filter((item) => item.severity === 'warning').length,
    sheets,
  };
}

function resultFromStructuralIssues(issues: OrderListParseIssue[]): OrderListParseResult {
  const sheetMetadata = new Map<string, SheetMetadata>();
  return {
    valid: false,
    structuralValid: false,
    rows: [],
    issues,
    summary: buildSummary([], issues, issues, sheetMetadata),
  };
}

// Parse the three-product order-list XLSX. Structural and row errors are
// returned rather than discarded. Duplicate product IDs are retained and
// every duplicate occurrence is marked invalid.
export async function parseOrderListWorkbook(buffer: Buffer): Promise<OrderListParseResult> {
  if (buffer.byteLength === 0) {
    return resultFromStructuralIssues([
      makeIssue('error', 'empty_workbook', 'Excelファイルが空です。'),
    ]);
  }
  if (buffer.byteLength > ORDER_LIST_MAX_FILE_SIZE_BYTES) {
    return resultFromStructuralIssues([
      makeIssue(
        'error',
        'workbook_too_large',
        'Excelファイルは' + ORDER_LIST_MAX_FILE_SIZE_BYTES / 1024 / 1024 + 'MB以下にしてください。'
      ),
    ]);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return resultFromStructuralIssues([
      makeIssue(
        'error',
        'workbook_read_failed',
        'Excelファイルを読み取れません: ' + detail
      ),
    ]);
  }

  const totalWorkbookRows = workbook.worksheets.reduce(
    (total, worksheet) => total + worksheet.actualRowCount,
    0,
  );
  if (totalWorkbookRows > ORDER_LIST_MAX_DATA_ROWS + ORDER_LIST_SHEETS.length) {
    return resultFromStructuralIssues([
      makeIssue('error', 'workbook_too_many_rows', `Excelの行数は3シート合計${ORDER_LIST_MAX_DATA_ROWS.toLocaleString()}件以下にしてください。`),
    ]);
  }

  const rows: OrderListRow[] = [];
  const structuralIssues: OrderListParseIssue[] = [];
  const sheetMetadata = new Map<string, SheetMetadata>();

  for (const { sheetName, franchise } of ORDER_LIST_SHEETS) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      structuralIssues.push(makeIssue(
        'error',
        'missing_sheet',
        '必須シート「' + sheetName + '」がありません。',
        { sheetName }
      ));
      sheetMetadata.set(sheetName, { found: false, headerRowNumber: null });
      continue;
    }

    const headerResult = detectHeaderRow(worksheet);
    structuralIssues.push(...headerResult.issues);
    sheetMetadata.set(sheetName, {
      found: true,
      headerRowNumber: headerResult.headerInfo?.rowNumber ?? null,
    });
    if (!headerResult.headerInfo) continue;

    const sheetRows = parseSheetRows(worksheet, franchise, headerResult.headerInfo);
    if (sheetRows.length === 0) {
      structuralIssues.push(makeIssue(
        'warning',
        'empty_sheet',
        'シート「' + sheetName + '」にデータ行がありません。',
        { sheetName }
      ));
    }
    rows.push(...sheetRows);
  }

  addDuplicateIssues(rows);
  const rowIssues = rows.flatMap((row) => row.validationIssues);
  const issues = [...structuralIssues, ...rowIssues];
  const structuralValid = structuralIssues.every((item) => item.severity !== 'error');

  return {
    valid: structuralValid && rowIssues.every((item) => item.severity !== 'error'),
    structuralValid,
    rows,
    issues,
    summary: buildSummary(rows, issues, structuralIssues, sheetMetadata),
  };
}
