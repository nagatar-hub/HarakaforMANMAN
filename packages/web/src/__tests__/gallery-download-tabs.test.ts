import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript';
import * as downloads from '../lib/download-images';

test('店頭・郵送タブの表示と一括・選択DLが混ざらず、切替時に選択を解除する', async () => {
  const page = (id: string, postal = false, old = false, franchise = 'Pokemon') => ({
    id, run_id: old ? 'old' : 'new', run_started_at: old ? '2026-10-06T01:00:00Z' : '2026-10-06T02:00:00Z',
    kind: postal ? 'postal' : 'store', is_peleka_postal: postal, franchise,
    page_index: 0, page_label: id, display_name: postal ? `郵送買取 ${franchise} ${id} (1).png` : id, card_ids: [], image_url: `https://images/${id}.png`,
  });
  let images = [page('store-1'), page('postal-1', true), page('store-2', false, false, 'OnePiece'),
    page('postal-2', true, false, 'OnePiece'), page('old-store', false, true), page('old-postal', true, true)];
  const states: any[] = [];
  let cursor = 0;
  let effect: (() => void) | undefined;
  const fetchFiles = jest.fn(async (list: downloads.DownloadableImage[]) => list as unknown as File[]);
  const zip = jest.fn(async () => {});
  const source = readFileSync(resolve(__dirname, '../app/gallery/[date]/page.tsx'), 'utf8');
  const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2017, module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as { default: () => any } };
  const load = (name: string): any => {
    if (name === 'react') return {
      useState: (initial: any) => {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useEffect: (callback: () => void) => { effect = callback; },
    };
    if (name === 'next/navigation') return { useParams: () => ({ date: '2026-10-06' }) };
    if (name === '@/lib/download-images') return { ...downloads, fetchImagesAsFiles: fetchFiles, downloadFilesAsZip: zip, isShareSupported: () => false };
    if (name === 'next/link' || name === 'next/image') return { __esModule: true, default: name };
    if (name === '@/components/franchise-tabs') return { FranchiseTabs: 'FranchiseTabs' };
    if (name.includes('modal') || name.includes('gallery-tabs')) return {};
    return require(name);
  };
  new Function('require', 'module', 'exports', 'fetch', compiled)(load, module, module.exports,
    async () => ({ ok: true, json: async () => images }));
  const render = () => { cursor = 0; return module.exports.default(); };
  const nodes = (node: any): any[] => !node || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const text = (node: any): string => node == null || typeof node === 'boolean' ? ''
    : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
  const button = (label: string) => {
    const found = nodes(render()).find(node => node.type === 'button' && text(node) === label);
    expect(found).toBeDefined();
    return found;
  };
  const clickImage = (id: string) => {
    const found = nodes(render()).find(node => node.type === 'button' && nodes(node.props.children)
      .some(child => child.type === 'next/image' && child.props.alt === id));
    expect(found).toBeDefined();
    found.props.onClick();
  };
  const visibleIds = () => nodes(render()).filter(node => node.type === 'next/image').map(node => node.props.alt);
  const downloadedIds = () => fetchFiles.mock.calls.at(-1)![0].map(item => item.image_url.split('/').pop());
  render();
  effect!();
  await new Promise(resolve => setImmediate(resolve));

  expect(button('店頭買取').props['aria-pressed']).toBe(true);
  expect(visibleIds()).toEqual(['store-1', 'store-2']);
  await button('店頭を一括DL').props.onClick();
  expect(downloadedIds()).toEqual(['store-1.png', 'store-2.png']);
  button('店頭を選択DL').props.onClick();
  clickImage('store-2');
  await button('ダウンロード (1件)').props.onClick();
  expect(downloadedIds()).toEqual(['store-2.png']);

  button('店頭を選択DL').props.onClick();
  clickImage('store-1');
  button('郵送買取').props.onClick();
  expect(visibleIds()).toEqual(['postal-1', 'postal-2']);
  const postalLabels = nodes(render()).filter(node => node.type === 'p' && node.props.title);
  expect(postalLabels.map(node => text(node))).toEqual(['postal-1', 'postal-2']);
  expect(postalLabels.every(node => node.props.className.includes('break-words') && !node.props.className.includes('truncate'))).toBe(true);
  expect(nodes(render()).filter(node => node.type === 'p').some(node => text(node).includes('郵送買取'))).toBe(false);
  await button('郵送を一括DL').props.onClick();
  expect(downloadedIds()).toEqual(['postal-1.png', 'postal-2.png']);
  button('郵送を選択DL').props.onClick();
  expect(button('ダウンロード (0件)').props.disabled).toBe(true);
  clickImage('postal-2');
  await button('ダウンロード (1件)').props.onClick();
  expect(downloadedIds()).toEqual(['postal-2.png']);
  nodes(render()).find(node => node.type === 'FranchiseTabs').props.onChange('Pokemon');
  await button('郵送を一括DL').props.onClick();
  expect(downloadedIds()).toEqual(['postal-1.png']);

  images = images.filter(image => !image.is_peleka_postal || image.run_id === 'old');
  effect!();
  await new Promise(resolve => setImmediate(resolve));
  expect(button('郵送を一括DL').props.disabled).toBe(true);
  images = images.filter(image => !image.is_peleka_postal);
  effect!();
  await new Promise(resolve => setImmediate(resolve));
  expect(visibleIds()).toEqual(['store-1']);
  await button('一括DL').props.onClick();
  expect(downloadedIds()).toEqual(['store-1.png']);
});
