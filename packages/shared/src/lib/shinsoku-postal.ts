/** Prices come directly from the public postal buyback page's first-party API. */
export interface PostalCandidate {
  source: string;
  id: string;
  franchise: string;
  name: string;
  modelNumber: string | null;
  productType: 'PSA10' | 'BOX';
}

export interface ShinsokuPostalProduct {
  id: string;
  franchise: string;
  name: string;
  modelNumber: string | null;
  productType: 'PSA10' | 'BOX';
  price: number | null;
  imageUrl: string | null;
}

const BRANDS: Record<string, string> = {
  Pokemon: 'ポケモン', 'ONE PIECE': 'ワンピース', 'YU-GI-OH!': '遊戯王',
  'DRAGON BALL': 'DB', 'WEISS SCHWARZ': 'ヴァイスシュヴァルツ',
};
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function nameKey(value: string, type: PostalCandidate['productType'], franchise: string): string {
  let name = normalize(value).replace(/^[【\[]?psa10[】\]]?/, '').replace(/[【\[]psa10[】\]]$/, '');
  if (type === 'PSA10') name = name.replace(/\(sa\)$/, '');
  if (type === 'BOX') {
    name = name.replace(/^[【\[]1?box[】\]]/, '')
      .replace(/^(?:ポケモンカードゲーム)?(?:スカーレット&バイオレット|ソード&シールド)?(?:強化拡張パック|拡張パック|ハイクラスパック)/, '')
      .replace(/^「(.+)」(?:\([a-z0-9+&/\-]+\))?$/, '$1');
    if (franchise === 'ONE PIECE') name = name.replace(/^(?:op|eb|prb)\d{2}(?!\d)/, '');
    if (franchise === 'DRAGON BALL') name = name.replace(/(?:fb|sb)\d{2}$/, '');
  }
  return name;
}

function identity(product: Pick<PostalCandidate, 'franchise' | 'name' | 'modelNumber' | 'productType'>): string {
  return JSON.stringify([product.franchise, product.productType, nameKey(product.name, product.productType, product.franchise),
    product.productType === 'PSA10' ? normalize(product.modelNumber ?? '') : '']);
}

export function matchShinsokuPostalProducts(candidates: PostalCandidate[], products: ShinsokuPostalProduct[]) {
  const index = new Map<string, ShinsokuPostalProduct[]>();
  for (const product of products) {
    const key = identity(product);
    const bucket = index.get(key) ?? [];
    if (!bucket.some(p => p.id === product.id)) bucket.push(product);
    index.set(key, bucket);
  }
  const matched = new Map<string, { product: ShinsokuPostalProduct; sources: PostalCandidate[] }>();
  const unmatched: { candidate: PostalCandidate; reason: 'not_found' | 'ambiguous' | 'missing_price' | 'missing_model' }[] = [];
  for (const candidate of candidates) {
    const matches = index.get(identity(candidate)) ?? [];
    const reason = candidate.productType === 'PSA10' && !candidate.modelNumber?.trim() ? 'missing_model'
      : matches.length === 0 ? 'not_found' : matches.length > 1 ? 'ambiguous'
        : !matches[0].price ? 'missing_price' : null;
    if (reason) { unmatched.push({ candidate, reason }); continue; }
    const product = matches[0];
    const result = matched.get(product.id) ?? { product, sources: [] };
    if (!result.sources.some(s => s.source === candidate.source && s.id === candidate.id)) result.sources.push(candidate);
    matched.set(product.id, result);
  }
  return { matched: [...matched.values()], unmatched };
}

export interface ShinsokuPostalFetchOptions {
  fetchImpl?: typeof fetch;
  delayMs?: number;
  maxPages?: number;
  franchises?: string[];
  candidates?: PostalCandidate[];
}

export async function fetchShinsokuPostalProducts(options: ShinsokuPostalFetchOptions = {}): Promise<ShinsokuPostalProduct[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const products = new Map<string, ShinsokuPostalProduct>();
  const delay = () => new Promise(resolve => setTimeout(resolve, options.delayMs ?? 150));
  async function read(franchise: string, productType: 'PSA10' | 'BOX', query?: string) {
    const brand = BRANDS[franchise];
    if (!brand) throw new Error(`Unsupported Shinsoku franchise: ${franchise}`);
    const seenPages = new Set<string>();
    for (let page = 0; page < (options.maxPages ?? 500); page++) {
      const params = new URLSearchParams({ postal_only: 'true', type: productType === 'PSA10' ? 'PSA' : 'BOX',
        brand, page: String(page), limit: '100', sort: 'name_asc' });
      if (query) params.set('query', query);
      let body: any;
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay();
        try {
          const response = await fetchImpl(`https://shinsoku-tcg.com/api/items?${params}`, { signal: AbortSignal.timeout(20_000) });
          if (!response.ok) {
            if (response.status !== 429 && response.status < 500) throw new Error(`Shinsoku HTTP ${response.status}`);
            if (attempt === 2) throw new Error(`Shinsoku HTTP ${response.status}`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
          }
          body = await response.json();
          break;
        } catch (error) {
          if (attempt === 2 || (error instanceof Error && /Shinsoku HTTP 4(?!29)/.test(error.message))) throw error;
        }
      }
      if (body?.ok !== true || !Array.isArray(body.data?.items) || typeof body.data.has_more !== 'boolean') {
        throw new Error('Invalid Shinsoku response');
      }
      const items = body.data.items;
      const signature = JSON.stringify(items.map((item: any) => item?.id));
      if (body.data.has_more && (!items.length || seenPages.has(signature))) throw new Error('Shinsoku pagination did not advance');
      seenPages.add(signature);
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id || (item.item_id != null && item.id !== item.item_id)
          || item.brand !== brand || item.type !== (productType === 'PSA10' ? 'PSA' : 'BOX')
          || item.is_postal_buy_target !== true || typeof item.name_processed !== 'string' || !item.name_processed.trim()) {
          throw new Error('Invalid Shinsoku product identity');
        }
        if (productType === 'PSA10' && (!Array.isArray(item.tags) || !item.tags.some((tag: any) => tag?.slug === 'psa10'))) continue;
        const price = item.postal_purchase_price_s;
        if (price !== null && (!Number.isSafeInteger(price) || price < 0)) throw new Error(`Invalid Shinsoku S price: ${item.id}`);
        if (item.modelno != null && typeof item.modelno !== 'string') throw new Error(`Invalid Shinsoku model: ${item.id}`);
        const product: ShinsokuPostalProduct = { id: item.id, franchise, name: item.name_processed,
          modelNumber: item.modelno?.trim() || null, productType, price: price || null,
          imageUrl: typeof item.image_url_public === 'string' ? item.image_url_public : null };
        const existing = products.get(product.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(product)) {
          const changed = (Object.keys(product) as (keyof ShinsokuPostalProduct)[]).filter(key => existing[key] !== product[key]);
          throw new Error(`Conflicting Shinsoku product: ${product.id} (${changed.join(',')})`);
        }
        products.set(product.id, product);
      }
      if (!body.data.has_more) return;
    }
    throw new Error('Shinsoku pagination limit exceeded');
  }
  for (const franchise of options.franchises ?? Object.keys(BRANDS)) {
    await read(franchise, 'PSA10');
    await read(franchise, 'BOX');
  }
  // Name sorting is not stable across same-name items; targeted searches recover omitted models.
  const searches = new Set<string>();
  const lookups: { candidate: PostalCandidate; query: string }[] = [];
  for (const { candidate, reason } of matchShinsokuPostalProducts(options.candidates ?? [], [...products.values()]).unmatched) {
    if (reason !== 'not_found') continue;
    const query = candidate.productType === 'PSA10' ? candidate.modelNumber
      : candidate.name.normalize('NFKC').replace(/^\s*[【\[]1?box[】\]]\s*/i, '');
    if (!query) continue;
    const key = JSON.stringify([candidate.franchise, candidate.productType, query]);
    if (searches.has(key)) continue;
    searches.add(key);
    lookups.push({ candidate, query });
  }
  let next = 0;
  let failed = false;
  const workers = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (!failed && next < lookups.length) {
      const { candidate, query } = lookups[next++];
      try { await read(candidate.franchise, candidate.productType, query); }
      catch (error) { failed = true; throw error; }
    }
  }));
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  return [...products.values()];
}
