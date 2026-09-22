// CLI only: candidate collection, never automatic variant approval or production writes.
// npx tsx packages/job/src/scripts/scrape-tcgmp.ts targets.json output/tcgmp/candidates
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { TCGMP_CATEGORY, searchTcgmp, getTcgmpDetail, getTcgmpImage,
  type TcgmpFranchise } from '../lib/tcgmp.js';

type Target = { id: string; franchise: TcgmpFranchise; name: string; model_number: string | null; query?: string; product_type?: 'psa' | 'box' };
export function parseTargets(input: unknown): Target[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Expected nonempty target array');
  const seen = new Set<string>();
  return input.map(row => {
    if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id) || seen.has(row.id)
      || !Object.hasOwn(TCGMP_CATEGORY, row.franchise) || typeof row.name !== 'string' || !row.name.trim()
      || !(row.model_number === null || typeof row.model_number === 'string')
      || (row.product_type !== undefined && !['psa', 'box'].includes(row.product_type))
      || (row.query !== undefined && (typeof row.query !== 'string' || !row.query.trim() || row.query.length > 200))) {
      throw new Error('Invalid or duplicate TCGMP target');
    }
    seen.add(row.id);
    return { id: row.id, franchise: row.franchise, name: row.name, model_number: row.model_number,
      ...(row.query ? { query: row.query } : {}), ...(row.product_type ? { product_type: row.product_type } : {}) };
  });
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Usage: scrape-tcgmp.ts targets.json output-directory');
  const targets = parseTargets(JSON.parse(await readFile(resolve(input), 'utf8')));
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  // ponytail: one canonical CLI lock; use this entry point for all crawls in a checkout.
  const lockPath = resolve(__dirname, '../../../../.tcgmp-crawl.lock');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(String(process.pid));
    for (const target of targets) {
      const fingerprint = createHash('sha256').update(JSON.stringify(target)).digest('hex');
      const reportPath = join(directory, `${target.id}-${fingerprint.slice(0, 12)}.json`);
      let savedCandidates: Record<string, unknown>[] = [];
      try {
        const prior = JSON.parse(await readFile(reportPath, 'utf8'));
        if (prior.fingerprint === fingerprint && prior.collection_complete === true) {
          console.log(`${target.id}: cached candidates (not approved)`);
          continue;
        }
        if (prior.fingerprint === fingerprint && Array.isArray(prior.candidates)) savedCandidates = prior.candidates;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const report: Record<string, unknown> = {
        target, fingerprint, collected_at: new Date().toISOString(), approved: false,
        collection_complete: false, search_scope: 'first search page; not a complete variant catalog', candidates: savedCandidates,
      };
      try {
        const candidates = await searchTcgmp(target.franchise, target.query ?? target.model_number ?? target.name);
        const results: Record<string, unknown>[] = [...savedCandidates];
        report.candidates = results;
        for (const candidate of candidates) {
          const cached = results.find(row => row.id === candidate.id);
          if (cached && typeof cached.sha256 === 'string' && /^[a-f0-9]{64}$/.test(cached.sha256)
            && ['jpg', 'png'].some(ext => cached.file === `${cached.sha256}.${ext}`)) {
            const bytes = await readFile(join(directory, String(cached.file)));
            if (createHash('sha256').update(bytes).digest('hex') !== cached.sha256) throw new Error('Cached image checksum mismatch');
            continue;
          }
          const detail = await getTcgmpDetail(candidate.id);
          const bytes = Buffer.from(await getTcgmpImage(detail.imageUrl));
          const metadata = await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata();
          if (!['jpeg', 'png'].includes(metadata.format ?? '') || !metadata.width || !metadata.height
            || metadata.width < 200 || metadata.height < 200 || (metadata.pages ?? 1) !== 1) {
            throw new Error(`Invalid card image: ${candidate.id}`);
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const filename = `${sha256}.${metadata.format === 'jpeg' ? 'jpg' : 'png'}`;
          await writeFile(join(directory, filename), bytes, { flag: 'w' });
          results.push({ ...detail, page_url: candidate.detailUrl, file: filename, sha256,
            width: metadata.width, height: metadata.height, approved: false });
          await writeFile(reportPath, JSON.stringify(report, null, 2));
        }
        report.collection_complete = true;
      } catch (error) {
        report.error = error instanceof Error ? error.message : 'TCGMP collection failed';
        process.exitCode = 1;
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(`${target.id}: ${(report.candidates as unknown[]).length} candidates, approved=0${report.error ? `, ${report.error}` : ''}`);
      // Isolated connection resets may affect one product; retain its report and continue at the same rate.
      // Access/rate-limit/HTML errors still stop the whole crawl, without retries or bypasses.
      if (report.error && report.error !== 'TCGMP transport error (ECONNRESET)') break;
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'TCGMP CLI failed');
  process.exitCode = 1;
});
