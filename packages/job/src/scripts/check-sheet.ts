import { getAccessToken } from '../lib/auth.js';

async function main() {
  const token = await getAccessToken();
  const sid = process.env.HARAKA_DB_SPREADSHEET_ID;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent('DB!A1:H3')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
main();
