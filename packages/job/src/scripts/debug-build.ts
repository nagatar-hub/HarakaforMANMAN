import { getAccessToken } from '../lib/auth.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { buildDbCardRows } from '../lib/db-card-sync.js';
import { DB_COLS } from '@haraka/shared';

async function main() {
  console.log('DB_COLS:', JSON.stringify(DB_COLS));
  const token = await getAccessToken();
  const sid = process.env.HARAKA_DB_SPREADSHEET_ID!;

  const allRows = await fetchSheetValues({
    accessToken: token,
    spreadsheetId: sid,
    range: 'DB',
  });

  console.log('Header:', JSON.stringify(allRows[0]));
  console.log('Row 1:', JSON.stringify(allRows[1]));
  console.log('Row 2:', JSON.stringify(allRows[2]));

  const dataRows = allRows.slice(1);
  const cards = buildDbCardRows(dataRows);

  console.log('\n--- buildDbCardRows output (first 3) ---');
  for (let i = 0; i < 3 && i < cards.length; i++) {
    console.log(JSON.stringify(cards[i]));
  }
  console.log(`Total: ${cards.length}`);
}
main();
