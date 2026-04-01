import { getAccessToken } from '../src/lib/auth.js';
async function main() {
  const token = await getAccessToken();
  const sheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/RarityIcons!A1:Z100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
main();
