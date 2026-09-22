/** Freeze already-selected gallery images locally; never publishes or changes product matching. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

type Source = { id: string; source_shinsoku_id: string; image_url: string | null; alt_image_url: string | null; [key: string]: unknown };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hosts = new Set(['fexadnveyuqduiujewrc.supabase.co', 'abyecthqjjssegwazhwm.supabase.co',
  'www.pokemon-card.com', 'firebasestorage.googleapis.com', 'storage.googleapis.com', 'www.cardrush-pokemon.jp']);

async function download(url: string): Promise<Buffer> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || !hosts.has(target.hostname)) throw Error('Unsupported image URL');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw Error(`Image HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 12 * 1024 * 1024) { await reader.cancel(); throw Error('Image exceeds 12 MiB'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function archiveTokyoMatchedImages(sources: Source[], output: string) {
  if (!sources.length || new Set(sources.map(row => row.id)).size !== sources.length) throw Error('Unique nonempty source rows required');
  await mkdir(output, { recursive: true });
  const prior = await readFile(resolve(output, 'manifest.json'), 'utf8').then(JSON.parse).catch((error: any) => {
    if (error.code === 'ENOENT') return { images: [] }; throw error;
  });
  const images: any[] = [], failed: { id: string; reason: string }[] = [];
  const writes = new Map<string, Promise<void>>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (next < sources.length) {
      const row = sources[next++];
      try {
        const cached = prior.images.find((entry: any) => entry.id === row.id && entry.source_shinsoku_id === row.source_shinsoku_id
          && entry.image_url === row.image_url && entry.alt_image_url === row.alt_image_url);
        let bytes: Buffer | undefined, sourceUrl: string | undefined;
        if (cached && /^[a-f0-9]{64}\.(jpg|png|webp)$/.test(cached.file)) {
          const local = await readFile(resolve(output, cached.file)).catch(() => null);
          if (local && sha(local) === cached.sha256) { bytes = local; sourceUrl = cached.archived_url; }
        }
        let metadata: sharp.Metadata | undefined;
        for (const url of [...new Set([row.image_url, row.alt_image_url].filter(Boolean) as string[])]) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              bytes ??= await download(url);
              const decoder = sharp(bytes, { limitInputPixels: 25_000_000 });
              metadata = await decoder.metadata();
              await decoder.stats();
              if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw Error('Invalid image format');
              sourceUrl ??= url;
              break;
            } catch { bytes = undefined; metadata = undefined; sourceUrl = undefined; }
          }
          if (metadata) break;
        }
        if (!bytes || !metadata) throw Error('Image unavailable or invalid after retries');
        const checksum = sha(bytes), file = `${checksum}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
        if (!writes.has(file)) writes.set(file, writeFile(resolve(output, file), bytes, { flag: 'wx' }).catch(async error => {
          if (error.code !== 'EEXIST' || sha(await readFile(resolve(output, file))) !== checksum) throw error;
        }));
        await writes.get(file);
        images.push({ ...row, archived_url: sourceUrl, sha256: checksum, file, bytes: bytes.length, width: metadata.width, height: metadata.height });
      } catch (error) { failed.push({ id: row.id, reason: error instanceof Error ? error.message : 'Archive failed' }); }
    }
  }));
  const manifest = { kind: 'tokyo_matched_image_archive_v1', store: 'manman-akihabara', created_at: new Date().toISOString(),
    requested: sources.length, images: images.sort((a, b) => a.id.localeCompare(b.id)), failed };
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  const [sourcePath, galleryPath, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw Error('Usage: archive-tokyo-matched-images sources.json gallery.json output-dir');
  const parse = async (file: string) => JSON.parse((await readFile(resolve(file), 'utf8')).replace(/^\uFEFF/, ''));
  const sources: Source[] = await parse(sourcePath), pages = await parse(galleryPath);
  if (!pages.length || pages.some((page: any) => page.status !== 'generated') || new Set(pages.map((page: any) => page.run_id)).size !== 1) throw Error('Single completed gallery run required');
  const ids = new Set<string>(pages.flatMap((page: any) => page.card_ids));
  const selected = sources.filter(row => ids.has(row.id));
  if (selected.length !== ids.size) throw Error('Gallery/source coverage mismatch');
  const result = await archiveTokyoMatchedImages(selected, resolve(output));
  console.log(JSON.stringify({ requested: result.requested, archived: result.images.length, failed: result.failed.length, output: resolve(output) }));
  if (result.failed.length) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
