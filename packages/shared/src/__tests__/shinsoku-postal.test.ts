import { fetchShinsokuPostalProducts, matchShinsokuPostalProducts, type PostalCandidate, type ShinsokuPostalProduct } from '../lib/shinsoku-postal';

const candidate: PostalCandidate = { source: 'kecak', id: 'k1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10' };
const product: ShinsokuPostalProduct = { id: 's1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 13900, imageUrl: null };
const item = { id: 's1', item_id: 's1', name_processed: 'カイ', modelno: '236/172', brand: 'ポケモン', type: 'PSA', tags: [{ slug: 'psa10' }], is_postal_buy_target: true, postal_purchase_price_s: 13900, postal_purchase_price_a: 1 };
const reply = (items: unknown[], has_more = false) => ({ ok: true, status: 200, json: async () => ({ ok: true, data: { items, has_more } }) });

test('three-list union deduplicates only proven identity, with model, state and franchise boundaries', () => {
  const candidates = ['kecak', 'bank', 'avirill'].map(source => ({ ...candidate, source }));
  const result = matchShinsokuPostalProducts(candidates, [product, { ...product, id: 's2', modelNumber: '077/067', price: 9600 }]);
  expect(result.matched).toEqual([{ product, sources: candidates }]);
  expect(result.unmatched).toEqual([]);
  expect(matchShinsokuPostalProducts([{ ...candidate, modelNumber: null }], [product]).unmatched[0].reason).toBe('missing_model');
  expect(matchShinsokuPostalProducts([{ ...candidate, franchise: 'ONE PIECE' }], [product]).matched).toEqual([]);
  expect(matchShinsokuPostalProducts([candidate], [product, { ...product, id: 'variant' }]).unmatched[0].reason).toBe('ambiguous');
  expect(matchShinsokuPostalProducts([candidate], [{ ...product, price: null }]).unmatched[0].reason).toBe('missing_price');
});

test('BOX normalization preserves deluxe variants', () => {
  const box = { ...candidate, name: '[1BOX]ホワイトフレア', productType: 'BOX' as const, modelNumber: null };
  const regular = { ...product, productType: 'BOX' as const, name: '拡張パック「ホワイトフレア」(SV11W)', modelNumber: null };
  expect(matchShinsokuPostalProducts([box], [regular]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([box], [{ ...regular, name: '拡張パックデラックス「ホワイトフレア」(SV11W)' }]).matched).toHaveLength(0);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'ONE PIECE', name: '[1BOX]謀略の王国' }], [{ ...regular, franchise: 'ONE PIECE', name: 'OP04 謀略の王国' }]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'ONE PIECE', name: 'メモリアルコレクション' }], [{ ...regular, franchise: 'ONE PIECE', name: 'EB01 メモリアルコレクション' }]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'DRAGON BALL', name: 'MANGA BOOSTER 01' }], [{ ...regular, franchise: 'DRAGON BALL', name: 'MANGA BOOSTER 01 SB01' }]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, name: '[1BOX]謀略の王国' }], [{ ...regular, name: 'OP04 謀略の王国(初版)' }]).matched).toHaveLength(0);
});

test('PSA SA display suffix uses same model while substantive parentheses remain distinct', () => {
  const card = { ...candidate, name: 'エーフィ＆デオキシスGX', modelNumber: '177/173' };
  const listed = { ...product, name: 'エーフィ＆デオキシスGX(SA)', modelNumber: '177/173' };
  expect(matchShinsokuPostalProducts([card], [listed]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([card], [{ ...listed, modelNumber: '176/173' }]).matched).toHaveLength(0);
  expect(matchShinsokuPostalProducts([{ ...candidate, name: 'ニンフィアEX(ピンク)' }], [{ ...product, name: 'ニンフィアEX' }]).matched).toHaveLength(0);
});

test('direct postal client paginates, filters PSA10, uses only S price, recovers missed models by query', async () => {
  const mock = jest.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    if (params.get('type') === 'BOX') return reply([]);
    if (params.has('query')) return reply([item]);
    return reply([{ ...item, id: 's2', item_id: 's2', modelno: '077/067' },
      { ...item, id: 'psa9', item_id: 'psa9', tags: [{ slug: 'psa9' }] }]);
  });
  const products = await fetchShinsokuPostalProducts({ fetchImpl: mock as unknown as typeof fetch, delayMs: 0, franchises: ['Pokemon'], candidates: [candidate] });
  expect(products).toEqual([{ ...product, id: 's2', modelNumber: '077/067' }, product]);
  expect(mock.mock.calls.some(([url]) => new URL(url).searchParams.get('query') === '236/172')).toBe(true);
  expect(mock.mock.calls.every(([url]) => new URL(url).searchParams.get('postal_only') === 'true')).toBe(true);
});

test('invalid prices, conflicting duplicate IDs and stuck pagination fail instead of publishing partial data', async () => {
  for (const responses of [
    [reply([{ ...item, postal_purchase_price_s: '13900' }])],
    [reply([item], true), reply([{ ...item, postal_purchase_price_s: 500 }])],
    [reply([item], true), reply([item], true)],
    [{ ok: true, status: 200, json: async () => ({ ok: true, data: { items: [] } }) }],
  ]) {
    let index = 0;
    await expect(fetchShinsokuPostalProducts({ fetchImpl: (async () => responses[index++]) as unknown as typeof fetch, delayMs: 0, franchises: ['Pokemon'] })).rejects.toThrow();
  }
});

test('fallback is bounded to two GETs and drains in-flight work before a conflict failure', async () => {
  let inFlight = 0;
  let maximum = 0;
  let completed = 0;
  const mock = jest.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    if (!params.has('query')) return reply(params.get('type') === 'PSA' ? [item] : []);
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, params.get('query') === 'missing0' ? 5 : 25));
    inFlight--;
    completed++;
    return reply([{ ...item, postal_purchase_price_s: 100 }]);
  });
  await expect(fetchShinsokuPostalProducts({ fetchImpl: mock as unknown as typeof fetch, delayMs: 0,
    franchises: ['Pokemon'], candidates: [0, 1, 2, 3].map(i => ({ ...candidate, modelNumber: `missing${i}` }))
  })).rejects.toThrow('Conflicting Shinsoku product: s1 (price)');
  expect(maximum).toBe(2);
  expect(inFlight).toBe(0);
  expect(completed).toBe(2);
});
