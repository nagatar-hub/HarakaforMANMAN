/**
 * Google Drive ダウンロードヘルパー
 *
 * テンプレート画像、カード裏面画像、レアリティアイコン等を
 * Google Drive から Buffer としてダウンロードする。
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

/**
 * Google Drive ファイルを Buffer としてダウンロード
 */
export async function downloadDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const url = `${DRIVE_API_BASE}/${fileId}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive download failed (${fileId}): ${res.status} ${res.statusText} — ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * URL（Drive ID or HTTP URL）から画像をダウンロード
 *
 * - Google Drive のファイル ID なら Drive API 経由
 * - https:// URL ならそのまま fetch
 * - 失敗時は null を返す
 */
export async function downloadImage(
  accessToken: string,
  urlOrDriveId: string,
): Promise<Buffer | null> {
  try {
    if (urlOrDriveId.startsWith('http://') || urlOrDriveId.startsWith('https://')) {
      // 通常の HTTP(S) URL（ブラウザ UA で Cloudflare 等のボット対策に対応）
      const res = await fetch(urlOrDriveId, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
      if (!res.ok) {
        console.warn(`[downloadImage] HTTP ${res.status} ${res.statusText}: ${urlOrDriveId.substring(0, 100)}`);
        return null;
      }
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      // Google Drive ファイル ID
      return await downloadDriveFile(accessToken, urlOrDriveId);
    }
  } catch (err) {
    console.warn(`[downloadImage] 例外: ${urlOrDriveId.substring(0, 80)} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 複数の画像を並列ダウンロード（同時接続数制限付き）
 */
export async function downloadImagesWithConcurrency(
  accessToken: string,
  urls: (string | null)[],
  concurrency: number = 5,
): Promise<(Buffer | null)[]> {
  const results: (Buffer | null)[] = new Array(urls.length).fill(null);
  let index = 0;

  async function worker() {
    while (index < urls.length) {
      const currentIndex = index++;
      const url = urls[currentIndex];
      if (!url) continue;
      results[currentIndex] = await downloadImage(accessToken, url);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
