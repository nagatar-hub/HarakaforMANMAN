const ORIGIN = 'https://www.tcgmp.jp';
const IMAGE_HOST = 'd1sqsdq2kxn50g.cloudfront.net';
export const TCGMP_CATEGORY = { Pokemon: 44, 'ONE PIECE': 57, 'YU-GI-OH!': 1, 'WEISS SCHWARZ': 3, 'DRAGON BALL': 60 } as const;
export type TcgmpFranchise = keyof typeof TCGMP_CATEGORY;
export interface TcgmpCandidate { id: string; name: string; detailUrl: string; imageUrl: string }
export interface TcgmpDetail { id: string; name: string; sku: string; description: string; imageUrl: string }

function decode(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}
function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(["\x27])([\\s\\S]*?)\\1', 'i'));
  return match ? decode(match[2]) : undefined;
}
export function validateTcgmpImageUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== IMAGE_HOST || url.port || url.username || url.password ||
      !/^\/(?:TS|TL|TXL)\/[A-Za-z0-9/_-]+\.(?:jpg|jpeg|png)$/i.test(url.pathname) || url.search || url.hash) {
    throw new Error('Invalid TCGMP image URL');
  }
  return url.href;
}
function detailUrl(id: string): string {
  if (!/^\d+$/.test(id)) throw new Error('Invalid TCGMP product ID');
  return `${ORIGIN}/s/product/detail?id=${id}`;
}

/** Only candidates on the supplied page, NOT the complete catalog. Never auto-select a variant. */
export function parseTcgmpSearch(html: string): TcgmpCandidate[] {
  const candidates = new Map<string, TcgmpCandidate>();
  for (const anchor of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const href = attr(anchor[0].split('>')[0], 'href');
    if (!href) continue;
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== '/s/product/detail') continue;
    const img = anchor[0].match(/<img\b[^>]*>/i)?.[0];
    if (!img) continue;
    const id = url.searchParams.get('id') ?? '';
    const src = attr(img, 'src');
    const name = attr(img, 'alt');
    if (!src || !name) throw new Error('Incomplete TCGMP search image');
    candidates.set(id, { id, name, detailUrl: detailUrl(id), imageUrl: validateTcgmpImageUrl(src) });
  }
  if (!/name\s*=\s*["']word["']/i.test(html)) throw new Error('Unexpected TCGMP search HTML');
  return [...candidates.values()];
}

export function parseTcgmpDetail(html: string, id: string): TcgmpDetail {
  detailUrl(id);
  const products: Record<string, unknown>[] = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attr(script[1], 'type') !== 'application/ld+json') continue;
    const data = JSON.parse(script[2]);
    if (data?.['@type'] === 'Product') products.push(data);
  }
  const images = [...html.matchAll(/<a\b[^>]*>/gi)]
    .filter(a => attr(a[0], 'rel') === 'image').map(a => attr(a[0], 'href'));
  const product = products[0];
  if (products.length !== 1 || images.length !== 1 || !images[0] ||
      !product || typeof product.name !== 'string' || !product.name ||
      typeof product.sku !== 'string' || !product.sku || typeof product.description !== 'string') {
    throw new Error('Unexpected TCGMP product HTML');
  }
  // Deliberately omit offers/prices; TCGMP supplies images, never buyback prices.
  return { id, name: product.name, sku: product.sku, description: product.description, imageUrl: validateTcgmpImageUrl(images[0]) };
}

// ponytail: process-local single queue; the operator must run only one crawler process.
let queue: Promise<unknown> = Promise.resolve();
let lastFinished = 0;
function request(url: string, image: boolean): Promise<Uint8Array> {
  const task = queue.then(async () => {
    const wait = Math.max(0, lastFinished + 8000 - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`TCGMP HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (!(image ? /^image\/(jpeg|png)(?:;|$)/i : /^text\/html(?:;|$)/i).test(type)) throw new Error('Unexpected TCGMP content type');
      const limit = image ? 12 * 1024 * 1024 : 4 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new Error('TCGMP response too large');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty TCGMP response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > limit) throw new Error('TCGMP response too large');
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks, length);
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown } }).cause?.code;
      if (typeof cause === 'string' && /^[A-Z0-9_]+$/.test(cause)) {
        throw new Error(`TCGMP transport error (${cause})`);
      }
      throw error;
    } finally { lastFinished = Date.now(); }
  });
  queue = task.catch(() => undefined);
  return task;
}
/** First search page only; absence or a single candidate does not prove unique variant coverage. */
export async function searchTcgmp(franchise: TcgmpFranchise, word: string): Promise<TcgmpCandidate[]> {
  if (!Object.hasOwn(TCGMP_CATEGORY, franchise) || !word.trim() || word.length > 200) throw new Error('Invalid TCGMP search');
  const url = new URL('/s/product/', ORIGIN);
  url.search = new URLSearchParams({ prc_id: String(TCGMP_CATEGORY[franchise]), word }).toString();
  return parseTcgmpSearch(new TextDecoder().decode(await request(url.href, false)));
}
export async function getTcgmpDetail(id: string): Promise<TcgmpDetail> {
  return parseTcgmpDetail(new TextDecoder().decode(await request(detailUrl(id), false)), id);
}
export async function getTcgmpImage(url: string): Promise<Uint8Array> {
  return request(validateTcgmpImageUrl(url), true);
}
