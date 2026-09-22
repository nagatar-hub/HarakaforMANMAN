import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { archiveTokyoMatchedImages } from '../scripts/archive-tokyo-matched-images';

test('native archive verifies bytes, reports failure, reuses cache, and CLI selects gallery IDs only', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tokyo-archive-test-'));
  const original = global.fetch;
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } }).png().toBuffer();
  const good = { id: 'shown', source_shinsoku_id: 'source-shown', image_url: 'https://storage.googleapis.com/good.png', alt_image_url: null };
  const bad = { ...good, id: 'failed', source_shinsoku_id: 'source-failed', image_url: 'https://storage.googleapis.com/bad.png' };
  const fetcher = jest.fn(async (url: any) => new Response(url.includes('bad') ? 'broken image' : new Uint8Array(bytes)));
  global.fetch = fetcher as any;
  try {
    const result = await archiveTokyoMatchedImages([good, bad], join(folder, 'direct'));
    expect(result.images.map(row => row.id)).toEqual(['shown']);
    expect(result.failed.map(row => row.id)).toEqual(['failed']);
    expect(result.images[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(join(folder, 'direct', result.images[0].file))).toEqual(bytes);
    fetcher.mockClear();
    fetcher.mockImplementation(async () => { throw Error('No network allowed on cache hit'); });
    const cached = await archiveTokyoMatchedImages([good], join(folder, 'direct'));
    expect(cached.images).toHaveLength(1); expect(cached.failed).toEqual([]); expect(fetcher).not.toHaveBeenCalled();

    const sources = join(folder, 'sources.json'), gallery = join(folder, 'gallery.json');
    await writeFile(sources, JSON.stringify([good, bad]));
    await writeFile(gallery, JSON.stringify([{ run_id: 'test-run', status: 'generated', card_ids: ['shown'] }]));
    const filename = resolve(__dirname, '../scripts/archive-tokyo-matched-images.ts');
    const source = await readFile(filename, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} }, actualRequire = createRequire(filename);
    const request = Object.assign((id: string) => actualRequire(id), { main: module });
    const completion = new Promise<string>((done, reject) => {
      vm.runInNewContext(compiled, { require: request, module, exports: module.exports, Buffer, URL, AbortSignal, process: { argv: ['node', 'script', sources, gallery, join(folder, 'direct')] }, fetch: fetcher, console: { log: done, error: reject } });
    });
    expect(JSON.parse(await completion)).toMatchObject({ requested: 1, archived: 1, failed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  } finally { global.fetch = original; await rm(folder, { recursive: true, force: true }); }
});
