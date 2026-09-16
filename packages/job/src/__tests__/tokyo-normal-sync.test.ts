import { buildTokyoPreparedCards, loadTokyoCardImageMappings } from '../lib/tokyo-normal-cards';
import { normalizeStorePricingSettings, type TokyoCardImageMappingRow } from '@haraka/shared';
import type { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';

const snapshot = { snapshot: { id: 'snapshot-1', store: 'manman-akihabara', business_date: '2026-09-07', settings: normalizeStorePricingSettings({}) },
  products: [
    { id: 'psa-1', franchise: 'Pokemon', product_type: 'psa', name: 'カイ', model_number: '236/172', image_url: 'https://example.com/psa.png', source_price: 10000, price_high: 9300 },
    { id: 'box-1', franchise: 'ONE PIECE', product_type: 'box', name: '謀略の王国', model_number: null, image_url: 'https://example.com/box.png', source_price: 20000, price_high: 18600 },
  ] } as unknown as Awaited<ReturnType<typeof buildTokyoBuybackSnapshot>>;

test('normal prepared cards apply BOX lower discount to the selected source price', () => {
  const rows = buildTokyoPreparedCards('run-1', snapshot);
  expect(rows.map(row => [row.source_shinsoku_id,row.tag,row.price_high,row.price_low,row.source,row.price_source]))
    .toEqual([['psa-1','PSA10',9300,9300,'shinsoku','shinsoku'],['box-1','BOX',18600,17000,'shinsoku','shinsoku']]);
  expect(rows[0]).toMatchObject({ run_id:'run-1',grade:'PSA10',list_no:'236/172',image_url:null,alt_image_url:null,price_source_date:'2026-09-07' });
  expect(rows[1].image_url).toBe('https://example.com/box.png');
});

const mapping: TokyoCardImageMappingRow = {
  provider: 'tcgmp', provider_product_id: '123',
  source_shinsoku_id: 'psa-1', franchise: 'Pokemon', product_type: 'psa', name: 'カイ', model_number: '236/172',
  tcgmp_product_id: '123', tcgmp_sku: 'sku-1', sha256: 'a'.repeat(64),
  image_url: `https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/tcgmp/${'a'.repeat(64)}.png`,
  verified_at: '2026-09-07T00:00:00Z', evidence: { no_sample: true, no_slab: true, variant_confirmed: true, note: 'exact variant and image checked' },
};

test.each([
  ['Pokemon', 20000, 0.15, 17000], ['ONE PIECE', 11000, 0.15, 9300],
  ['YU-GI-OH!', 12000, 0.15, 10000], ['DRAGON BALL', 20000, 0.13, 17000],
  ['WEISS SCHWARZ', 120000, 0.13, 100000], ['Pokemon', 20000, 0, 20000],
  ['DRAGON BALL', 7000, 0.13, 6000], ['YU-GI-OH!', 6000, 0.15, 5100],
  ['Pokemon', 20000, 1, 0],
])('BOX %s lower price discounts selected source once (%s, %s)', (franchise, source, rate, expected) => {
  const settings = normalizeStorePricingSettings({ box_discount_rates: { [franchise]: { shrink: 0.07, no_shrink: rate } } });
  const priceHigh = Number(source);
  const product = { ...snapshot.products[1], franchise: String(franchise), source_price: Number(source), price_high: priceHigh };
  const [row] = buildTokyoPreparedCards('run', { ...snapshot, snapshot: { ...snapshot.snapshot, settings }, products: [product] });
  expect(row).toMatchObject({ price_high: priceHigh, price_low: expected, tag: 'BOX' });
});

test('BOX fails closed without valid upper price or frozen no-shrink setting', () => {
  const prepare = (upper: number, rate: number) => buildTokyoPreparedCards('run', {
    ...snapshot, snapshot: { ...snapshot.snapshot, settings: { ...snapshot.snapshot.settings,
      box_discount_rates: { ...snapshot.snapshot.settings.box_discount_rates, 'ONE PIECE': { shrink: 0.07, no_shrink: rate } } } },
    products: [{ ...snapshot.products[1], price_high: upper }],
  });
  for (const value of [NaN, Infinity, 0, -1, 0.5]) expect(() => prepare(value, 0.15)).toThrow('Invalid Tokyo prepared');
  for (const rate of [NaN, Infinity, -0.1, 1.1]) expect(() => prepare(20000, rate)).toThrow('Invalid Tokyo BOX');
  expect(() => buildTokyoPreparedCards('run', { ...snapshot, snapshot: { ...snapshot.snapshot, settings: undefined } } as any)).toThrow('Invalid Tokyo BOX');
});

test('verified mappings change only their exact products and preserve snapshot values', () => {
  const priorSnapshot = JSON.stringify(snapshot);
  const before = buildTokyoPreparedCards('run-1', snapshot);
  const boxMapping = { ...mapping, source_shinsoku_id: 'box-1', franchise: 'ONE PIECE' as const, product_type: 'box' as const,
    name: '謀略の王国', model_number: null, provider: 'haraka' as const,
    provider_product_id: '11111111-1111-1111-1111-111111111111', tcgmp_product_id: null, tcgmp_sku: null,
    image_url: mapping.image_url.replace('/tcgmp/', '/haraka/') };
  const after = buildTokyoPreparedCards('run-1', snapshot, [mapping, boxMapping]);
  expect(after).toEqual([{ ...before[0], image_url: mapping.image_url }, { ...before[1], image_url: boxMapping.image_url,
    db_card_id: boxMapping.provider_product_id }]);
  expect(JSON.stringify(snapshot)).toBe(priorSnapshot);
});

test('KECAK fallback reuses the import-confirmed DB image instead of rematching a PSA number', () => {
  const image = 'https://www.pokemon-card.com/assets/images/confirmed.png';
  const product = { ...snapshot.products[0], id: 'kecak:excel-1', franchise: 'DRAGON BALL', name: 'エナジーマーカー',
    model_number: 'E-115', origins: [{ source: 'kecak', id: 'excel-1', dbCardId: 'confirmed' }] };
  const cards = [
    { id: 'confirmed', store: 'manman-akihabara', franchise: 'DRAGON BALL', card_name: '別表記A', grade: 'PSA10', list_no: '別番号', image_url: image, alt_image_url: null, tag: 'エナジーマーカー/パラレル' },
    { id: 'ambiguous', store: 'manman-akihabara', franchise: 'DRAGON BALL', card_name: 'エナジーマーカー', grade: 'PSA10', list_no: 'E-115', image_url: 'https://www.pokemon-card.com/assets/images/other.png', alt_image_url: null },
  ] as any;
  expect(buildTokyoPreparedCards('run', { ...snapshot, products: [product] } as any, [], cards)[0])
    .toMatchObject({ image_url: image, db_card_id: 'confirmed', tag: 'エナジーマーカー/パラレル' });
});

test.each(['DRAGON BALL', 'WEISS SCHWARZ'])('direct Shinsoku %s PSA keeps its first-party image', franchise => {
  const image = 'https://shinsoku-tcg.com/product.png';
  const product = { ...snapshot.products[0], id: 'direct-psa', franchise, image_url: image,
    origins: [{ source: 'shinsoku', id: 'direct-psa' }] };
  expect(buildTokyoPreparedCards('run', { ...snapshot, products: [product] } as any)[0]).toMatchObject({ image_url: image });
});

test('26 reviewed main-tag fallbacks require exact identity, defer to DB tags and do not affect image or price', () => {
  const cases = [
    ['IAP2300022856','ナギ','088/078','サポート'], ['IAP2300023198','ブースターEX','006/032','イーブイ'],
    ['IAP2500005877','メガカイリューex','250/193','メガシンカex'], ['IAP2300023611','メガヤミラミ＆バンギラスGX(SA)','102/094','TAG'],
    ['IAP2300023390','ポッチャマ','052/049','CHR'], ['IAP2300023795','リザードン','005/032','リザードン'],
    ['IAP2500002618','レックウザV','075/067','V'], ['IAO2500003918','モンキー・D・ルフィ','P-043','プロモ'],
    ['IAP2300023819','リザードンex','139/108','リザードン'], ['IAP2500004443','メガリザードンXex','116/080','リザードン'],
    ['IAP2300023708','ライチュウ＆アローラライチュウGX(SA)','057/054','TAG'], ['IAO2300025596','モンキー・D・ルフィ','P-033','プロモ'],
    ['IAP2400003183','ピカチュウex','132/106','ピカチュウ'], ['IAP2500000336','リザードンex','125/108','リザードン'],
    ['IAP2600003975','メガリザードンXex','223/193','リザードン'], ['IAP2500002595','メガサーナイトex','092/063','メガシンカex'],
    ['IAP2300023079','ピカチュウ＆ゼクロムGX','100/095','TAG'], ['IAP2500002563','メガルカリオex','092/063','メガシンカex'],
    ['IAP2600003417','メガジガルデex','117/080','メガシンカex'], ['IAP2300023832','リザードンGX','052/051','リザードン'],
    ['IAP2300023791','リザードン','011/087','リザードン'], ['IAP2300022894','ニンフィアGX','057/051','イーブイ'],
    ['IAP2500002073','エーフィGX','062/060','イーブイ'], ['IAP2300023085','ピカチュウEX','008/027','ピカチュウ'],
    ['IAP2500003843','ミュウツー&ミュウGX','097/094','TAG'], ['IAP2300023027','ピカチュウ','010/032','ピカチュウ'],
  ];
  expect(cases).toHaveLength(26);
  for (const [id, name, model_number, expectedTag] of cases) {
    const product = { ...snapshot.products[0], id, name, model_number, franchise: id.startsWith('IAO') ? 'ONE PIECE' : 'Pokemon' };
    const prepare = (patch = {}, cards: any[] = []) => buildTokyoPreparedCards('run', { ...snapshot, products: [{ ...product, ...patch }] }, [], cards)[0];
    const expected = prepare({ id: 'unlisted' });
    expect(prepare()).toEqual({ ...expected, source_shinsoku_id: id, tag: expectedTag });
    for (const patch of [{ id: 'unlisted' }, { name: name + '別版' }, { model_number: model_number + 'x' }, { franchise: 'WEISS SCHWARZ' }]) {
      expect(prepare(patch)).toMatchObject({ tag: 'PSA10', image_url: null, price_high: 9300, price_low: 9300 });
    }
    expect(prepare({}, [{ id: 'db', store: 'manman-akihabara', franchise: product.franchise, card_name: name,
      list_no: model_number, grade: 'PSA10', tag: 'DB優先', image_url: null, alt_image_url: null }])).toMatchObject({ tag: 'DB優先', image_url: null });
  }
  const yu = { ...snapshot.products[0], id: 'IAX2600000407', franchise: 'YU-GI-OH!' };
  expect(buildTokyoPreparedCards('run', { ...snapshot, products: [yu] }, [], [{ id: 'db', store: 'manman-akihabara',
    franchise: yu.franchise, card_name: yu.name, list_no: yu.model_number, grade: 'PSA10', tag: '青眼', image_url: null, alt_image_url: null } as any])[0].tag).toBe('青眼');
});

test.each(['haraka', 'onphalos'] as const)('reviewed %s selection persists ahead of automatic DB matching without changing prices', provider => {
  const image = { ...mapping, provider, provider_product_id: provider === 'haraka' ? '11111111-1111-1111-1111-111111111111' : '1234',
    tcgmp_product_id: null, tcgmp_sku: null, image_url: mapping.image_url.replace('/tcgmp/', `/${provider}/`) };
  const dbRows = [{ id: 'auto-card', store: 'manman-akihabara', franchise: 'Pokemon', card_name: 'カイ', name: 'カイ',
    grade: 'PSA10', tag: 'サポート/SAR', list_no: '236/172', image_status: 'alive', image_url: 'https://www.pokemon-card.com/assets/images/auto.png', alt_image_url: null }] as any;
  const row = buildTokyoPreparedCards('run-1', snapshot, [image], dbRows)[0];
  expect(row).toMatchObject({ image_url: image.image_url, db_card_id: provider === 'haraka' ? image.provider_product_id : 'auto-card', tag: 'サポート/SAR', price_high: 9300, price_low: 9300, source: 'shinsoku' });
});

test.each([
  { source_shinsoku_id: 'other-id' }, { franchise: 'ONE PIECE' }, { name: 'カイ(SA)' }, { model_number: '236/173' },
  { image_url: 'https://example.com/unsafe.png' }, { image_url: mapping.image_url + '?sample=true' },
  { sha256: 'b'.repeat(64) }, { evidence: { ...mapping.evidence, no_sample: false } },
  { evidence: { ...mapping.evidence, no_slab: false } }, { evidence: { ...mapping.evidence, variant_confirmed: false } },
  { evidence: { ...mapping.evidence, note: '' } },
])('unverified/mismatched mapping never falls back to PSA slab: %j', patch => {
  const [row] = buildTokyoPreparedCards('run-1', snapshot, [{ ...mapping, ...patch } as TokyoCardImageMappingRow]);
  expect(row).toMatchObject({ image_url: null, alt_image_url: null, price_high: 9300, price_source: 'shinsoku' });
});

test('public postal ID preserves reviewed image and tag across equivalent names, not different models', () => {
  const product = { ...snapshot.products[0], id: 'IAP2300022856' };
  const reviewed = { ...mapping, source_shinsoku_id: product.id, name: 'カイ(SA)',
    evidence: { ...mapping.evidence, tag: 'サポート/SAR', tag_basis: 'reviewed identity', tag_plan_sha256: 'c'.repeat(64) } };
  const prepare = (candidate: TokyoCardImageMappingRow) => buildTokyoPreparedCards('run', { ...snapshot, products: [product] }, [candidate])[0];
  expect(prepare(reviewed)).toMatchObject({ image_url: mapping.image_url, tag: 'サポート/SAR', price_high: 9300 });
  expect(prepare({ ...reviewed, model_number: '236/173' })).toMatchObject({ image_url: null, tag: 'PSA10' });
});

test('rejects non-Tokyo snapshots and duplicate mappings', () => {
  expect(() => buildTokyoPreparedCards('run-1', { ...snapshot, snapshot: { ...snapshot.snapshot, store: 'manman' } })).toThrow('Tokyo snapshot required');
  expect(() => buildTokyoPreparedCards('run-1', snapshot, [mapping, mapping])).toThrow('Duplicate');
});

test('PSA with missing model number remains in output without adopting a named image', () => {
  const missingModel = { ...snapshot, products: [{ ...snapshot.products[0], model_number: null }] };
  expect(buildTokyoPreparedCards('run-1', missingModel, [mapping])).toEqual([
    expect.objectContaining({ source_shinsoku_id: 'psa-1', image_url: null, alt_image_url: null, price_high: 9300 }),
  ]);
});

test('null-model ONPHALOS Pokemon PSA requires pixel-exact source hash evidence', () => {
  const product = { ...snapshot.products[0], model_number: null };
  const exact = { ...mapping, provider: 'onphalos' as const, provider_product_id: '1234', product_type: 'psa' as const,
    model_number: null, tcgmp_product_id: null, tcgmp_sku: null,
    image_url: mapping.image_url.replace('/tcgmp/', '/onphalos/'),
    evidence: { ...mapping.evidence, pixel_exact: true, source_image_sha256: mapping.sha256 } };
  const prepare = (candidate: any) => buildTokyoPreparedCards('run', { ...snapshot, products: [product] }, [candidate])[0].image_url;
  expect(prepare(exact)).toBe(exact.image_url);
  expect(prepare({ ...exact, evidence: { ...exact.evidence, pixel_exact: false } })).toBeNull();
  expect(prepare({ ...exact, evidence: { ...exact.evidence, source_image_sha256: 'b'.repeat(64) } })).toBeNull();
  expect(prepare({ ...exact, franchise: 'ONE PIECE' })).toBeNull();
});

test('uses a reviewed Pokemon tag only from an exact verified image mapping', () => {
  const reviewed = { ...mapping, provider: 'onphalos' as const, provider_product_id: '1234',
    tcgmp_product_id: null, tcgmp_sku: null, image_url: mapping.image_url.replace('/tcgmp/', '/onphalos/'),
    evidence: { ...mapping.evidence, tag: 'イーブイ/YU NAGABA', tag_basis: 'exact model and expansion', tag_plan_sha256: 'c'.repeat(64) } };
  const prepare = (candidate: any) => buildTokyoPreparedCards('run', snapshot, [candidate])[0];
  expect(prepare(reviewed).tag).toBe('イーブイ/YU NAGABA');
  expect(prepare({ ...reviewed, name: '別商品' }).tag).toBe('PSA10');
  expect(prepare({ ...reviewed, evidence: { ...reviewed.evidence, tag: 'TOP' } }).tag).toBe('PSA10');
  expect(prepare({ ...reviewed, evidence: { ...reviewed.evidence, tag: '不正\nタグ' } }).tag).toBe('PSA10');
});

test('null-model Cardrush PSA requires an exact source hash flag and matching hash at runtime', () => {
  const product = { ...snapshot.products[0], franchise: 'ONE PIECE', name: 'ドン!!カード', model_number: null };
  const exact = { ...mapping, provider: 'cardrush' as const, provider_product_id: '10197', franchise: 'ONE PIECE' as const,
    name: product.name, model_number: null, tcgmp_product_id: null, tcgmp_sku: null,
    image_url: mapping.image_url.replace('/tcgmp/', '/cardrush/'),
    evidence: { ...mapping.evidence, source_sha256_equal: true, source_image_sha256: mapping.sha256 } };
  const prepare = (candidate: any) => buildTokyoPreparedCards('run', { ...snapshot, products: [product] } as any, [candidate])[0].image_url;
  expect(prepare(exact)).toBe(exact.image_url);
  expect(prepare({ ...exact, evidence: { ...exact.evidence, source_sha256_equal: false } })).toBeNull();
  expect(prepare({ ...exact, evidence: { ...exact.evidence, source_image_sha256: 'b'.repeat(64) } })).toBeNull();
});

test('preserves previously reviewed null-model Cardrush YU-GI-OH mappings', () => {
  const product = { ...snapshot.products[0], franchise: 'YU-GI-OH!', name: '青眼の白龍', model_number: null };
  const reviewed = { ...mapping, provider: 'cardrush' as const, provider_product_id: '9001', franchise: 'YU-GI-OH!' as const,
    name: product.name, model_number: null, tcgmp_product_id: null, tcgmp_sku: null,
    image_url: mapping.image_url.replace('/tcgmp/', '/cardrush/') };
  expect(buildTokyoPreparedCards('run', { ...snapshot, products: [product] } as any, [reviewed])[0].image_url).toBe(reviewed.image_url);
  expect(buildTokyoPreparedCards('run', { ...snapshot, products: [{ ...product, franchise: 'ONE PIECE' }] } as any,
    [{ ...reviewed, franchise: 'ONE PIECE' }])[0].image_url).toBeNull();
});

test('mapping reader queries all Tokyo product IDs in bounded chunks and propagates errors', async () => {
  const query = jest.fn(async () => ({ data: [mapping], error: null }));
  const db = { from: jest.fn(() => ({ select: () => ({ in: query }) })) };
  expect(await loadTokyoCardImageMappings(db as any, snapshot)).toEqual([mapping]);
  expect(query).toHaveBeenCalledWith('source_shinsoku_id', ['psa-1', 'box-1']);
  query.mockClear();
  await loadTokyoCardImageMappings(db as any, { ...snapshot, products: Array.from({ length: 101 }, (_, index) => ({ ...snapshot.products[0], id: `psa-${index}` })) });
  expect(query.mock.calls.map(call => (call as unknown as [string, string[]])[1].length)).toEqual([100, 1]);
  const errorDb = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'unavailable' } }) }) }) };
  await expect(loadTokyoCardImageMappings(errorDb as any, snapshot)).rejects.toThrow('unavailable');
});

test('Tokyo normal sync claims then publishes and prepares all snapshot products, never accessing legacy pricing', async () => {
  const prior = { store:process.env.STORE_NAME, importId:process.env.ORDER_LIST_IMPORT_ID };
  process.env.STORE_NAME='manman-akihabara'; process.env.ORDER_LIST_IMPORT_ID='import-1';
  const auth = jest.fn(() => { throw new Error('legacy OAuth must not be called'); });
  const build = jest.fn(async () => snapshot);
  const prepared: unknown[] = [];
  const db = {
    rpc: jest.fn(async (name: string) => ({ data:name==='publish_tokyo_buyback_snapshot'?'snapshot-1':true,error:null })),
    from: jest.fn((table: string) => {
      if (table === 'db_card') return { select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) };
      if (table === 'tokyo_card_image_mapping') return { select: () => ({ in: async () => ({ data: [mapping], error: null }) }) };
      const chain: any = {};
      for (const method of ['update','eq','is','select']) chain[method]=jest.fn(() => chain);
      chain.insert=jest.fn((rows: unknown) => { if(table==='prepared_card') { prepared.push(...rows as unknown[]);return Promise.resolve({error:null}); }return chain; });
      chain.single=jest.fn(async () => ({ data: { id:table==='run'?'run-1':'import-1',business_date:'2026-09-07' },error:null }));
      chain.maybeSingle=jest.fn(async () => ({ data:{id:'run-1'},error:null }));
      return chain;
    }),
  };
  let runSync: () => Promise<void> = async () => {};
  jest.isolateModules(() => {
    jest.doMock('../lib/supabase', () => ({ createSupabaseClientFromSecrets:async()=>db }));
    jest.doMock('../lib/auth', () => ({ getAccessToken:auth }));
    jest.doMock('../lib/progress', () => ({ updateProgress:jest.fn(),clearProgress:jest.fn() }));
    jest.doMock('../lib/discord', () => ({ sendDiscordNotification:jest.fn(),COLOR:{} }));
    jest.doMock('../jobs/tokyo-buyback-sync', () => ({ TOKYO_BUYBACK_STORE:'manman-akihabara',buildTokyoBuybackSnapshot:build }));
    runSync=require('../jobs/sync').runSync;
  });
  try {
    await runSync();
    expect(auth).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(db,expect.any(Date),{claimedImportId:'import-1',runId:'run-1'});
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toMatchObject({ image_url: mapping.image_url, alt_image_url: null, price_high: 9300 });
    expect(db.rpc).toHaveBeenCalledWith('publish_tokyo_buyback_snapshot',expect.objectContaining({p_run_id:'run-1'}));
    expect(db.rpc).toHaveBeenCalledWith('finalize_order_list_sync',expect.objectContaining({p_import_id:'import-1',p_run_id:'run-1',p_total_prepared:2,p_total_pages:0}));
    expect(db.rpc).not.toHaveBeenCalledWith('fail_order_list_sync',expect.anything());
  } finally {
    if(prior.store===undefined) delete process.env.STORE_NAME; else process.env.STORE_NAME=prior.store;
    if(prior.importId===undefined) delete process.env.ORDER_LIST_IMPORT_ID; else process.env.ORDER_LIST_IMPORT_ID=prior.importId;
  }
});
