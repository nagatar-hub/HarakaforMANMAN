import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  ORDER_LIST_REQUIRED_HEADERS,
  ORDER_LIST_MAX_DATA_ROWS,
  parseOrderListWorkbook,
} from './order-list-parser.js';

type TestRow = Array<ExcelJS.CellValue>;

function addSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  rows: TestRow[],
  headers: readonly string[] = ORDER_LIST_REQUIRED_HEADERS,
  withPreamble = false
): void {
  const sheet = workbook.addWorksheet(sheetName);
  if (withPreamble) sheet.addRow(['オーダーリスト']);
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow(row);
}

function validRow(
  productId: string,
  overrides: Partial<Record<number, ExcelJS.CellValue>> = {}
): TestRow {
  const row: TestRow = [
    productId,
    'カード ' + productId,
    'PSA10',
    '拡張パック',
    'LIST-' + productId,
    'SR',
    'https://fexadnveyuqduiujewrc.supabase.co/cards/' + productId + '.jpg',
    3,
    1000,
  ];
  for (const [index, value] of Object.entries(overrides)) {
    row[Number(index)] = value;
  }
  return row;
}

function addNewProductSheets(workbook: ExcelJS.Workbook): void {
  addSheet(workbook, 'ヴァイス', [validRow('WS-1')]);
  addSheet(workbook, 'ドラゴンボール', [validRow('DB-1', { 2: 'シングル' })]);
}

async function asBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('5商材をヘッダー名で読み、数値・URL・rawRowを保持する', async () => {
  const workbook = new ExcelJS.Workbook();
  addSheet(
    workbook,
    'ポケモン',
    [[
      '0001',
      'ピカチュウ',
      'PSA10',
      '拡張パック',
      'SV-P',
      'PROMO',
      { text: '画像', hyperlink: 'https://fexadnveyuqduiujewrc.supabase.co/pokemon/0001.jpg' },
      '１２',
      '￥1,200円',
    ]],
    ORDER_LIST_REQUIRED_HEADERS,
    true
  );
  addSheet(workbook, 'ワンピース', [validRow('OP-1')]);
  addSheet(workbook, '遊戯王', [
    validRow('YG-1', {
      6: { formula: 'IMAGE("https://fexadnveyuqduiujewrc.supabase.co/yugioh/YG-1.jpg")', result: '画像' },
      8: { formula: '1500+1500', result: 3000 },
    }),
  ]);
  addNewProductSheets(workbook);

  const result = await parseOrderListWorkbook(await asBuffer(workbook));

  assert.equal(result.structuralValid, true);
  assert.equal(result.valid, true);
  assert.equal(result.summary.totalRows, 5);
  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.summary.sheets[0].headerRowNumber, 2);

  const pokemon = result.rows.find((row) => row.excelProductId === '0001');
  assert.ok(pokemon);
  assert.equal(pokemon.franchise, 'Pokemon');
  assert.equal(pokemon.demand, 12);
  assert.equal(pokemon.sourcePrice, 1200);
  assert.equal(pokemon.imageUrl, 'https://fexadnveyuqduiujewrc.supabase.co/pokemon/0001.jpg');
  assert.equal(pokemon.sheetRowNumber, 3);
  assert.deepEqual(pokemon.rawRow['画像'], {
    text: '画像',
    hyperlink: 'https://fexadnveyuqduiujewrc.supabase.co/pokemon/0001.jpg',
  });

  const yugioh = result.rows.find((row) => row.excelProductId === 'YG-1');
  assert.ok(yugioh);
  assert.equal(yugioh.sourcePrice, 3000);
  assert.equal(yugioh.imageUrl, 'https://fexadnveyuqduiujewrc.supabase.co/yugioh/YG-1.jpg');

  const weiss = result.rows.find((row) => row.excelProductId === 'WS-1');
  assert.equal(weiss?.franchise, 'WEISS SCHWARZ');
  const dragon = result.rows.find((row) => row.excelProductId === 'DB-1');
  assert.equal(dragon?.franchise, 'DRAGON BALL');
  assert.equal(dragon?.grade, 'シングル');
});

test('全角括弧やヘッダー内空白を正規化して列を特定する', async () => {
  const workbook = new ExcelJS.Workbook();
  const flexibleHeaders = [
    ...ORDER_LIST_REQUIRED_HEADERS.slice(0, 8),
    '納品希望価格 （税込）',
  ];
  addSheet(workbook, 'ポケモン', [validRow('PK-1')], flexibleHeaders);
  addSheet(workbook, 'ワンピース', [validRow('OP-1')], flexibleHeaders);
  addSheet(workbook, '遊戯王', [validRow('YG-1')], flexibleHeaders);
  addSheet(workbook, 'ヴァイス', [validRow('WS-1')], flexibleHeaders);
  addSheet(workbook, 'ドラゴンボール', [validRow('DB-1')], flexibleHeaders);

  const result = await parseOrderListWorkbook(await asBuffer(workbook));

  assert.equal(result.structuralValid, true);
  assert.equal(result.rows.length, 5);
});

test('未対応の追加シートを構造エラーとして報告する', async () => {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'ポケモン', [validRow('PK-1')]);
  addSheet(workbook, 'ワンピース', [validRow('OP-1')]);
  addSheet(workbook, '遊戯王', [validRow('YG-1')]);
  addNewProductSheets(workbook);
  addSheet(workbook, '新商材', [validRow('NEW-1')]);

  const result = await parseOrderListWorkbook(await asBuffer(workbook));

  assert.equal(result.structuralValid, false);
  assert.equal(result.issues[0]?.code, 'unsupported_sheet');
  assert.equal(result.issues[0]?.sheetName, '新商材');
});

test('シート・必須列の不足を構造エラーとして報告する', async () => {
  const workbook = new ExcelJS.Workbook();
  const headersWithoutImage = ORDER_LIST_REQUIRED_HEADERS.filter((header) => header !== '画像');
  addSheet(workbook, 'ポケモン', [validRow('PK-1')], headersWithoutImage);

  const result = await parseOrderListWorkbook(await asBuffer(workbook));

  assert.equal(result.structuralValid, false);
  assert.equal(result.valid, false);
  assert.equal(result.rows.length, 0);
  assert.equal(result.issues.filter((item) => item.code === 'missing_sheet').length, 4);
  assert.equal(
    result.issues.some((item) =>
      item.code === 'missing_required_headers' && item.value?.includes('画像')
    ),
    true
  );
});

test('重複や不正行を捨てず、各行のvalidationIssuesへ残す', async () => {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'ポケモン', [
    validRow('DUP-1', { 6: 'http://127.0.0.1/internal.jpg' }),
    validRow('ｄｕｐ－１'),
  ]);
  addSheet(workbook, 'ワンピース', [validRow('OP-1', { 7: 1.5 })]);
  addSheet(workbook, '遊戯王', [validRow('YG-1', { 8: '' })]);
  addNewProductSheets(workbook);

  const result = await parseOrderListWorkbook(await asBuffer(workbook));

  assert.equal(result.structuralValid, true);
  assert.equal(result.valid, false);
  assert.equal(result.rows.length, 6);
  assert.equal(result.summary.invalidRows, 4);
  assert.equal(result.summary.duplicateRows, 2);
  assert.equal(
    result.issues.filter((item) => item.code === 'duplicate_product_id').length,
    2
  );
  assert.equal(
    result.rows[0].validationIssues.some((item) => item.code === 'invalid_image_url'),
    true
  );
  assert.equal(
    result.rows[2].validationIssues.some((item) => item.code === 'invalid_demand'),
    true
  );
  assert.equal(
    result.rows[3].validationIssues.some((item) => item.code === 'missing_source_price'),
    true
  );
});

test('展開後の行数が上限を越えるworkbookを解析前に拒否する', async () => {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'ポケモン', [validRow('PK-1')]);
  addSheet(workbook, 'ワンピース', [validRow('OP-1')]);
  addSheet(workbook, '遊戯王', [validRow('YG-1')]);
  addNewProductSheets(workbook);

  const pokemon = workbook.getWorksheet('ポケモン')!;
  for (let index = 0; index <= ORDER_LIST_MAX_DATA_ROWS; index += 1) {
    pokemon.addRow([`OVERFLOW-${index}`]);
  }

  const result = await parseOrderListWorkbook(await asBuffer(workbook));
  assert.equal(result.structuralValid, false);
  assert.equal(result.issues.some((item) => item.code === 'workbook_too_many_rows'), true);
});

test('XLSXではないBufferを例外化せず構造エラーとして返す', async () => {
  const result = await parseOrderListWorkbook(Buffer.from('not an xlsx'));

  assert.equal(result.structuralValid, false);
  assert.equal(result.rows.length, 0);
  assert.equal(result.issues[0]?.code, 'workbook_read_failed');
});
