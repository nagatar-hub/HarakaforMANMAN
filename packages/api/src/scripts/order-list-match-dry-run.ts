import { readFile } from 'node:fs/promises';
import { createSupabaseClient } from '../lib/supabase.js';
import { parseOrderListWorkbook } from '../lib/order-list-parser.js';
import {
  matchOrderListRows,
  type DbCardMatchInput,
  type ExistingProductMapping,
} from '../lib/order-list-matcher.js';

const PAGE_SIZE = 1000;

async function fetchDbCards(): Promise<DbCardMatchInput[]> {
  const supabase = createSupabaseClient();
  const rows: DbCardMatchInput[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('db_card')
      .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<DbCardMatchInput[]>();
    if (error) throw new Error('db_card read failed: ' + error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchMappingsIfAvailable(): Promise<ExistingProductMapping[]> {
  const supabase = createSupabaseClient();
  const rows: ExistingProductMapping[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('excel_product_mapping')
      .select('id, franchise, excel_product_id, db_card_id, status')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
      .returns<ExistingProductMapping[]>();
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') return [];
      throw new Error('mapping read failed: ' + error.message);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

async function main(): Promise<void> {
  const workbookPath = process.argv[2];
  if (!workbookPath) {
    throw new Error('Usage: npm -w packages/api run dry-run:order-list-match -- <workbook.xlsx>');
  }

  const parsed = await parseOrderListWorkbook(await readFile(workbookPath));
  const [dbCards, mappings] = await Promise.all([
    fetchDbCards(),
    fetchMappingsIfAvailable(),
  ]);
  const results = matchOrderListRows(parsed.rows, dbCards, mappings);

  const statuses = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 };
  const methods = { existing_mapping: 0, exact_image: 0, exact_identity: 0 };
  const byFranchise: Record<string, typeof statuses> = {};

  for (const result of results) {
    statuses[result.status] += 1;
    const counts = byFranchise[result.row.franchise]
      ?? (byFranchise[result.row.franchise] = { matched: 0, ambiguous: 0, unmatched: 0, invalid: 0 });
    counts[result.status] += 1;
    if (result.method) methods[result.method] += 1;
  }

  const unresolved = results
    .filter((result) => result.status !== 'matched')
    .slice(0, 30)
    .map((result) => ({
      franchise: result.row.franchise,
      excelProductId: result.row.excelProductId,
      cardName: result.row.cardName,
      grade: result.row.grade,
      listNo: result.row.listNo,
      status: result.status,
      note: result.note,
      candidates: result.candidateDbCardIds.length,
    }));

  console.log(JSON.stringify({
    workbook: {
      structuralValid: parsed.structuralValid,
      valid: parsed.valid,
      rows: parsed.rows.length,
      warnings: parsed.summary.warningCount,
      errors: parsed.summary.errorCount,
    },
    database: {
      dbCards: dbCards.length,
      persistedMappings: mappings.length,
    },
    statuses,
    methods,
    byFranchise,
    unresolvedSample: unresolved,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
