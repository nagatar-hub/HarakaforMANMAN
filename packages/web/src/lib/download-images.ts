import JSZip from 'jszip';

export type DownloadableImage = {
  image_url: string;
  filename: string;
};

/** Web Share API が使えるかどうか */
export function isShareSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  const dummy = new File([''], 'test.png', { type: 'image/png' });
  return navigator.canShare({ files: [dummy] });
}

/**
 * 画像をfetchしてFile[]として返す（共有/ZIP用の前準備）
 */
export async function fetchImagesAsFiles(
  images: DownloadableImage[],
  onProgress?: (current: number, total: number) => void,
): Promise<File[]> {
  const files: File[] = [];
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length);
    try {
      const res = await fetch(images[i].image_url);
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], images[i].filename, { type: blob.type || 'image/png' }));
    } catch {
      // skip
    }
  }
  onProgress?.(images.length, images.length);
  return files;
}

/**
 * File[]をWeb Share APIで共有（ユーザーアクション直下で呼ぶこと）
 * 成功したらtrue、失敗/非対応ならfalse
 */
export async function shareFiles(files: File[]): Promise<boolean> {
  if (!isShareSupported() || files.length === 0) return false;
  try {
    await navigator.share({ files });
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return true; // キャンセルもOK扱い
    return false;
  }
}

/**
 * File[]をZIPにしてダウンロード
 */
export async function downloadFilesAsZip(files: File[], zipFilename: string): Promise<void> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file);
  }
  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, zipFilename);
}

/**
 * 従来互換: fetchしてそのままZIPダウンロード
 */
export async function downloadImagesAsZip(
  images: DownloadableImage[],
  zipFilename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const files = await fetchImagesAsFiles(images, onProgress);
  if (files.length === 0) return;
  await downloadFilesAsZip(files, zipFilename);
}

/**
 * 従来互換: fetchして共有 or ZIP
 */
export async function shareOrDownloadImages(
  images: DownloadableImage[],
  zipFilename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const files = await fetchImagesAsFiles(images, onProgress);
  if (files.length === 0) return;

  if (isShareSupported() && images.length <= 3) {
    const shared = await shareFiles(files);
    if (shared) return;
  }

  await downloadFilesAsZip(files, zipFilename);
}

/**
 * 単一画像をダウンロード/共有
 */
export async function downloadSingleImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch image');
  const blob = await res.blob();

  if (isShareSupported()) {
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const shared = await shareFiles([file]);
    if (shared) return;
  }

  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
