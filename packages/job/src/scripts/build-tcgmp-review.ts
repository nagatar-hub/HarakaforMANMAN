import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTargets } from './scrape-tcgmp.js';
import { findHarakaImage, harakaImageUrl } from '../lib/haraka-card-images.js';
import type { DbCardRow } from '@haraka/shared';

export async function buildTcgmpReview(targetPath: string, reportRoot: string, outputPath: string, harakaPath?: string) {
  const raw: unknown = JSON.parse(await readFile(targetPath, 'utf8'));
  const targets = parseTargets(raw);
  const originals = raw as { image_url?: string; local_image?: string; product_type?: string }[];
  const dbCards: DbCardRow[] = harakaPath ? JSON.parse(await readFile(harakaPath, 'utf8')).cards : [];
  if (!Array.isArray(dbCards)) throw new Error('Invalid Haraka DB export');
  const reports: { value: any; directory: string }[] = [];
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('-candidates')) await scan(join(directory, entry.name));
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
      if (value?.target && Array.isArray(value.candidates)) reports.push({ value, directory });
    }
  }
  await scan(reportRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  const items = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const productType = originals[i].product_type ?? 'psa';
    if (!['psa', 'box'].includes(productType)) throw new Error('Invalid product type');
    const haraka = findHarakaImage({ ...target, product_type: productType as 'psa' | 'box' }, dbCards);
    const report = reports.filter(({ value }) => value.target.id === target.id && value.target.name === target.name
      && (value.target.product_type ?? 'psa') === productType
      && value.target.franchise === target.franchise && value.target.model_number === target.model_number)
      .sort((a, b) => String(b.value.collected_at).localeCompare(String(a.value.collected_at)))[0];
    const candidates = [];
    const candidateIds = new Set<string>();
    for (const candidate of (haraka.status === 'missing' ? report?.value.candidates : []) ?? []) {
      if (!/^\d+$/.test(candidate.id) || !/^[a-f0-9]{64}$/.test(candidate.sha256)
        || candidateIds.has(candidate.id)
        || !['jpg', 'png'].some(ext => candidate.file === `${candidate.sha256}.${ext}`)
        || typeof candidate.name !== 'string' || typeof candidate.sku !== 'string') throw new Error('Invalid cached candidate');
      candidateIds.add(candidate.id);
      const bytes = await readFile(join(report!.directory, candidate.file));
      if (createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new Error('Candidate checksum mismatch');
      await writeFile(join(dirname(outputPath), candidate.file), bytes);
      candidates.push({ provider: 'tcgmp', id: candidate.id, name: candidate.name, sku: candidate.sku, description: candidate.description ?? '',
        sha256: candidate.sha256, file: candidate.file,
        image: `data:image/${candidate.file.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}` });
    }
    if (haraka.status === 'ambiguous') {
      for (const row of haraka.candidates) {
        const url = harakaImageUrl(row);
        if (url) candidates.push({ provider: 'haraka', id: row.id, name: row.card_name,
          sku: row.list_no ?? 'DB番号なし', description: 'Haraka DB の候補。番号・絵柄の確認が必要です。',
          sha256: undefined, file: undefined, image: url });
      }
    }
    let sourceImage = originals[i].image_url ?? '';
    if (sourceImage && !/^https:\/\/storage\.googleapis\.com\/shinsoku-tcg-public\/items\//.test(sourceImage)) throw new Error('Unexpected source image host');
    if (originals[i].local_image) {
      const path = resolve(dirname(targetPath), originals[i].local_image!);
      const within = relative(resolve(dirname(targetPath)), path);
      if (within.startsWith('..') || isAbsolute(within) || !/\.(png|jpg)$/i.test(path)) throw new Error('Invalid local source image');
      const bytes = await readFile(path);
      sourceImage = `data:image/${path.endsWith('.png') ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
    }
    items.push({ ...target, product_type: productType, sourceImage, candidates,
      harakaMatch: haraka.status === 'matched' ? { id: haraka.dbCardId, image: haraka.imageUrl } : null,
      harakaStatus: haraka.status,
      collection: !report ? 'not_collected' : report.value.error ? 'error' : 'collected',
      collectionError: report?.value.error ?? null, collectedAt: report?.value.collected_at ?? null });
  }
  const datasetId = createHash('sha256').update(JSON.stringify(items.map(item => ({
    id: item.id, franchise: item.franchise, name: item.name, model_number: item.model_number, product_type: item.product_type,
    sourceImage: item.sourceImage,
    harakaMatch: item.harakaMatch,
    candidates: item.candidates.map(candidate => ({ id: candidate.id, sku: candidate.sku, sha256: candidate.sha256,
      ...(candidate.provider === 'haraka' ? { image: candidate.image } : {}) })),
  })))).digest('hex');
  const data = { version: 1, datasetId, builtAt: new Date().toISOString(), items };
  const template = await readFile(resolve(__dirname, '../../src/scripts/tcgmp-review.html'), 'utf8');
  await writeFile(outputPath, template.replace('__REVIEW_DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c')));
  const missing = items.filter(item => item.harakaStatus === 'missing').map(item => ({
    id: item.id, franchise: item.franchise, name: item.name, model_number: item.model_number, product_type: item.product_type,
  }));
  const fetchIds = new Set(items.filter(item => !item.candidates.length).map(item => item.id));
  if (harakaPath) {
    await writeFile(join(dirname(outputPath), 'missing-image-targets.json'), JSON.stringify(missing, null, 2));
    await writeFile(join(dirname(outputPath), 'fetch-image-targets.json'), JSON.stringify(missing.filter(target => fetchIds.has(target.id)), null, 2));
  }
  return { outputPath, products: items.length, withCandidates: items.filter(item => item.candidates.length).length,
    candidates: items.reduce((count, item) => count + item.candidates.length, 0), datasetId,
    harakaMatched: items.filter(item => item.harakaMatch).length,
    harakaAmbiguous: items.filter(item => item.harakaStatus === 'ambiguous').length, missingHaraka: missing.length };
}

if (require.main === module) {
  const [targets, reports, output, haraka, ...extra] = process.argv.slice(2);
  if (!targets || !reports || !output || extra.length) throw new Error('Usage: build-tcgmp-review.ts targets.json report-root output.html');
  buildTcgmpReview(resolve(targets), resolve(reports), resolve(output), haraka ? resolve(haraka) : undefined).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error instanceof Error ? error.message : 'Review build failed'); process.exitCode = 1; });
}
