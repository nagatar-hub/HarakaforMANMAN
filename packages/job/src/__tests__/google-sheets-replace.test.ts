import { replaceSheetValues } from '../lib/google-sheets';

describe('replaceSheetValues', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('管理範囲のクリアと最新値の書き込みを1回のbatchUpdateで行う', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      if (!url.endsWith(':batchUpdate')) {
        return new Response(JSON.stringify({
          sheets: [{
            properties: {
              sheetId: 0,
              title: 'Sheet1',
              gridProperties: { rowCount: 100, columnCount: 26 },
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ spreadsheetId: 'sheet-id' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as typeof fetch;

    await replaceSheetValues({
      accessToken: 'token',
      spreadsheetId: 'sheet-id',
      sheetId: 0,
      values: [
        ['product-id', 'name'],
        ['id-1', 'Pikachu'],
      ],
      columnCount: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [updateUrl, updateInit] = fetchMock.mock.calls[1];
    expect(updateUrl).toBe('https://sheets.googleapis.com/v4/spreadsheets/sheet-id:batchUpdate');
    const body = JSON.parse(String((updateInit as RequestInit).body));
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      repeatCell: {
        range: {
          sheetId: 0,
          startRowIndex: 0,
          endRowIndex: 100,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        cell: {},
        fields: 'userEnteredValue',
      },
    });
    expect(body.requests[1].updateCells.rows).toHaveLength(2);
  });

  it('必要行数が現在のグリッドより大きい場合は行を追加する', async () => {
    const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
      if (!url.endsWith(':batchUpdate')) {
        return new Response(JSON.stringify({
          sheets: [{
            properties: {
              sheetId: 0,
              title: 'Sheet1',
              gridProperties: { rowCount: 1, columnCount: 9 },
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    global.fetch = fetchMock as typeof fetch;

    await replaceSheetValues({
      accessToken: 'token',
      spreadsheetId: 'sheet-id',
      sheetId: 0,
      values: [
        ['header'],
        ['row-1'],
        ['row-2'],
      ],
      columnCount: 1,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.requests[0]).toEqual({
      appendDimension: { sheetId: 0, dimension: 'ROWS', length: 2 },
    });
  });

  it('指定したgidが存在しない場合は書き込みを行わない', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ sheets: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    global.fetch = fetchMock as typeof fetch;

    await expect(replaceSheetValues({
      accessToken: 'token',
      spreadsheetId: 'sheet-id',
      sheetId: 0,
      values: [['header']],
      columnCount: 1,
    })).rejects.toThrow('出力先シートが見つかりません');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
