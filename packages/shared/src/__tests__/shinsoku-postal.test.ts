import { fetchShinsokuPostalProducts, matchShinsokuPostalProducts, postalProductIdentity, type PostalCandidate, type ShinsokuPostalProduct } from '../lib/shinsoku-postal';

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
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'WEISS SCHWARZ', name: '[1BOX]「Re:ゼロから始める異世界生活」Vol.3(初版再販問わず)' }],
    [{ ...regular, franchise: 'WEISS SCHWARZ', name: 'Re:ゼロから始める異世界生活 Vol.3' }]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'WEISS SCHWARZ', name: '[1BOX]ガンゲイル・オンラインⅡ(初版再販問わず)' }],
    [{ ...regular, franchise: 'WEISS SCHWARZ', name: 'ガンゲイル・オンラインII' }]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'WEISS SCHWARZ', name: '[1BOX]ブルーアーカイブ(初版再販問わず)' }], [
    { ...regular, id: 'blue-1', franchise: 'WEISS SCHWARZ', name: 'ブルーアーカイブ The Animation' },
    { ...regular, id: 'blue-2', franchise: 'WEISS SCHWARZ', name: 'ブルーアーカイブ 未開封BOX' },
  ]).matched).toEqual([expect.objectContaining({ product: expect.objectContaining({ id: 'blue-2' }) })]);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'ONE PIECE', name: '[1BOX]王族の血統' }], [
    { ...regular, franchise: 'ONE PIECE', name: 'ブースターパック 王族の血統' },
  ]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, franchise: 'ONE PIECE', name: '[1BOX]ONE PIECE Heroines Edition' }], [
    { ...regular, franchise: 'ONE PIECE', name: 'エクストラブースター ONE PIECE Heroines Edition' },
  ]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([{ ...box, name: '[1BOX]謀略の王国' }], [{ ...regular, name: 'OP04 謀略の王国(初版)' }]).matched).toHaveLength(0);
  expect(matchShinsokuPostalProducts([{ ...box, name: '拡張パック『熱風のアリーナ』' }], [
    { ...regular, name: '強化拡張パック「熱風のアリーナ」(SV9a)' },
  ]).matched).toHaveLength(1);
});

test('BOX identity absorbs source spelling variants that listed one product twice (Tokyo 2026-09-25)', () => {
  const box = (franchise: string, name: string) => postalProductIdentity({ franchise, name, modelNumber: null, productType: 'BOX' });
  const same = (franchise: string, a: string, b: string) => expect(box(franchise, a)).toBe(box(franchise, b));
  same('Pokemon', '拡張パックデラックス 「ブラックボルト」', '拡張パックデラックス「ブラックボルト」(SV11B)');
  same('Pokemon', '拡張パックデラックス 「ホワイトフレア」', '拡張パックデラックス「ホワイトフレア」(SV11W)');
  same('Pokemon', '拡張パック『25th ANNIVERSARY COLLECTION』', '拡張パック「25th ANNIVERSARY COLLECTION BOX」(S8a)');
  same('Pokemon', 'MEGA 拡張パック 30th CELEBRATION', '拡張パック「30th CELEBRATION」(M6a)');
  same('Pokemon', 'MEGA 拡張パック アビスアイ', '[1BOX]アビスアイ');
  same('Pokemon', 'MEGA 拡張パック ストームエメラルダ', '拡張パック「ストームエメラルダ」(M6)');
  same('ONE PIECE', 'ブースターパック 500年後の未来', 'OP07 500年後の未来');
  // 別商品は別のまま
  expect(box('Pokemon', '拡張パックデラックス「ブラックボルト」(SV11B)')).not.toBe(box('Pokemon', '拡張パック「ブラックボルト」(SV11B)'));
  expect(box('Pokemon', '25th ANNIVERSARY GOLDEN BOX')).not.toBe(box('Pokemon', '拡張パック「25th ANNIVERSARY COLLECTION BOX」(S8a)'));
  expect(box('Pokemon', '[1BOX]30th CELEBRATION FUTURISTIC BOX')).not.toBe(box('Pokemon', '拡張パック「30th CELEBRATION」(M6a)'));
});

test('PSA display labels do not split one card into two listings (Tokyo 2026-09-26)', () => {
  const psa = (name: string, modelNumber: string) => postalProductIdentity({ franchise: 'Pokemon', name, modelNumber, productType: 'PSA10' });
  for (const label of ['YU NAGABA', '25th', 'AR仕様', 'SAR仕様', 'SR仕様', 'RR仕様', 'RRR仕様', 'HR仕様', 'MUR仕様', 'R仕様', 'Classicキラ']) {
    expect(psa(`シャワーズ(${label})`, '063/SV-P')).toBe(psa('シャワーズ', '063/SV-P'));
  }
  for (const label of ['マスターボールミラー', '中国語版', 'エラー版', '白黒版', '1ED', 'パラレル/漫画背景']) {
    expect(psa(`シャワーズ(${label})`, '030/187')).not.toBe(psa('シャワーズ', '030/187'));
  }
});

test('known PSA display suffixes use the same model while substantive parentheses remain distinct', () => {
  const card = { ...candidate, name: 'エーフィ＆デオキシスGX', modelNumber: '177/173' };
  const listed = { ...product, name: 'エーフィ＆デオキシスGX(SA)', modelNumber: '177/173' };
  expect(matchShinsokuPostalProducts([card], [listed]).matched).toHaveLength(1);
  expect(matchShinsokuPostalProducts([card], [{ ...listed, modelNumber: '176/173' }]).matched).toHaveLength(0);
  expect(matchShinsokuPostalProducts([{ ...candidate, franchise: 'ONE PIECE', name: 'ウタ', modelNumber: 'OP09-002' }], [
    { ...product, franchise: 'ONE PIECE', name: 'ウタ(フラッグシップ)', modelNumber: 'OP09-002', price: 126000 },
  ]).matched[0].product.price).toBe(126000);
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

test('catalog pull without candidates never sends a product name or model query', async () => {
  const mock = jest.fn(async (url: string) => reply(new URL(url).searchParams.get('type') === 'PSA' ? [item] : []));
  await fetchShinsokuPostalProducts({ fetchImpl: mock as unknown as typeof fetch, delayMs: 0, franchises: ['Pokemon'] });
  expect(mock.mock.calls.every(([url]) => !new URL(url).searchParams.has('query'))).toBe(true);
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
