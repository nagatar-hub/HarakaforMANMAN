import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync';
import { assertOriparkCoverage, completeOriparkCoverage, coverageMatches, loadOriparkCoverage, type CoverageCard } from '../lib/oripark-coverage';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

const settings = normalizeStorePricingSettings({});
const card: CoverageCard = { id: 'ori-1', franchise: 'Pokemon', card_name: 'カイ', grade: 'PSA10',
  list_no: '236/172', tag: 'サポート', rarity: 'SAR', image_url: 'https://example.com/kai.png', alt_image_url: null,
  excel_product_id: 'excel-1', source: 'order_list', raw_import: { source_price: 120000, price_source: 'order_list' } };
const baseline = (cards = [card]) => ({ runId: 'oripark-run', businessDate: '2026-11-16', fingerprint: 'fingerprint', cards });
const compare = (rows: any[] = []) => compareTokyoSourceProducts(rows, [], settings, '2026-11-16T02:00:00Z');

test('omitted Excel products use the original price and Tokyo rates, with published image fallback', () => {
  const result = compare();
  const report = completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]));
  expect(result.products[0]).toMatchObject({ source_price: 120000, selected_high_source: 'kecak' });
  expect(result.products[0].price_high).toBe(compare([{ source: 'kecak', id: 'x', franchise: 'Pokemon',
    name: 'カイ', modelNumber: '236/172', productType: 'PSA10', sourcePrice: 120000 }]).products[0].price_high);
  const prepared = buildTokyoPreparedCards('tokyo-run', { products: result.products,
    snapshot: { store: 'manman-akihabara', business_date: '2026-11-16', report: { oripark_coverage: report } } } as any);
  expect(prepared[0]).toMatchObject({ image_url: card.image_url, tag: 'サポート', rarity: 'SAR', db_card_id: null });
  expect(() => assertOriparkCoverage(report, prepared as any)).not.toThrow();
  expect(() => assertOriparkCoverage(report, [])).toThrow('欠落');
});

test('current Tokyo source price wins and an Oripark price never overwrites it', () => {
  const result = compare([{ source: 'kecak', id: 'excel-1', franchise: 'Pokemon', name: 'カイ',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]);
  const before = JSON.stringify(result.products);
  completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]));
  expect(JSON.stringify(result.products)).toBe(before);
});

const saboAnniversary: CoverageCard = {
  id: 'ori-sabo-anniversary', franchise: 'ONE PIECE', card_name: 'サボ', grade: 'PSA10',
  list_no: 'OP07-118', tag: '3周年', rarity: 'SEC',
  image_url: 'https://example.com/sabo-anniversary.png', alt_image_url: 'https://example.com/sabo-anniversary.png',
  excel_product_id: '96a52690-c905-4018-9aad-7b776d4ba370', source: 'order_list',
  raw_import: { source_price: 8262, price_source: 'order_list', raw_row: { エキスパンション: '3rd ANNIVERSARY SET' } },
};
const saboSpecial: CoverageCard = {
  ...saboAnniversary, id: 'ori-sabo-special', image_url: 'https://example.com/sabo-op13-sp.png',
  excel_product_id: 'b53c9632-deef-44e2-8600-742ce0734b7f',
  raw_import: { source_price: 18054, price_source: 'order_list', raw_row: { エキスパンション: 'OP13' } },
};
const saboCandidate = (sourceId: string, sourcePrice: number) => ({ source: 'kecak', id: sourceId,
  franchise: 'ONE PIECE', name: 'サボ', modelNumber: 'OP07-118', productType: 'PSA10', sourcePrice });

function completeSaboVariants(cards: CoverageCard[], initial: any[] = []) {
  const result = compare(initial);
  const report = completeOriparkCoverage(result, baseline(cards), '2026-11-16', 1, c => compare([c]));
  const prepared = buildTokyoPreparedCards('tokyo-run', { products: result.products,
    snapshot: { store: 'manman-akihabara', business_date: '2026-11-16', report: { oripark_coverage: report } } } as any);
  expect(() => assertOriparkCoverage(report, prepared as any)).not.toThrow();
  const variants = cards.map(source => {
    const item = report.items.find(row => row.oriparkCardId === source.id)!;
    const product = result.products.find(row => row.id === item.productId)!;
    const rendered = prepared.find(row => row.source_shinsoku_id === item.productId)!;
    expect(product.origins).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'kecak', id: source.excel_product_id })]));
    expect(rendered.image_url).toBe(source.raw_import?.raw_row?.['画像'] ?? source.image_url);
    if (source.excel_product_id === saboSpecial.excel_product_id) {
      expect(rendered.alt_image_url).not.toBe(saboAnniversary.image_url);
    }
    expect(rendered.price_high).toBe(product.price_high);
    expect(rendered.price_low).toBe(product.price_low);
    return { sourceId: source.excel_product_id, productId: product.id, price: product.source_price,
      priceHigh: product.price_high, priceLow: product.price_low, image: rendered.image_url };
  }).sort((a, b) => a.sourceId!.localeCompare(b.sourceId!));
  expect(new Set(variants.map(row => row.productId)).size).toBe(cards.length);
  return { result, variants, report };
}

test('same-name Oripark source variants keep their own prices, images and stable IDs in either input order', () => {
  const first = completeSaboVariants([saboAnniversary, saboSpecial]);
  const reversed = completeSaboVariants([saboSpecial, saboAnniversary]);
  expect(first.result.products).toHaveLength(2);
  expect(reversed.result.products).toHaveLength(2);
  expect(reversed.variants).toEqual(first.variants);
  for (const source of [saboAnniversary, saboSpecial]) {
    const actual = first.variants.find(row => row.sourceId === source.excel_product_id)!;
    const expected = compare([saboCandidate(source.excel_product_id!, source.raw_import!.source_price!)]).products[0];
    expect(actual).toMatchObject({ price: source.raw_import!.source_price, priceHigh: expected.price_high, priceLow: expected.price_low });
  }
});

test.each([saboAnniversary, saboSpecial])('an exact Tokyo source ID retains its current price and ID when the other $id variant is supplemented', existing => {
  const current = saboCandidate(existing.excel_product_id!, 24000);
  const original = compare([current]).products[0];
  const first = completeSaboVariants([saboAnniversary, saboSpecial], [current]);
  const reversed = completeSaboVariants([saboSpecial, saboAnniversary], [current]);
  expect(first.result.products).toHaveLength(2);
  expect(reversed.variants).toEqual(first.variants);
  expect(first.result.products.find(product => product.id === original.id)).toMatchObject({
    id: original.id, source_price: original.source_price, price_high: original.price_high, price_low: original.price_low,
    selected_high_source: original.selected_high_source, selected_low_source: original.selected_low_source,
  });
  expect(first.variants.find(row => row.sourceId === existing.excel_product_id)).toMatchObject({ productId: original.id, price: 24000 });
  const other = existing === saboAnniversary ? saboSpecial : saboAnniversary;
  expect(first.variants.find(row => row.sourceId === other.excel_product_id)).toMatchObject({ price: other.raw_import!.source_price });
});

test('different names with a shared model number remain separate while Oripark variants are supplemented', () => {
  const unrelated = { source: 'shinsoku', id: 'unrelated-same-model', franchise: 'ONE PIECE', name: '別の商品名',
    modelNumber: 'OP07-118', productType: 'PSA10', sourcePrice: 500000 };
  const original = compare([unrelated]).products[0];
  const completed = completeSaboVariants([saboAnniversary, saboSpecial], [unrelated]);
  expect(completed.result.products).toHaveLength(3);
  expect(completed.result.products.find(product => product.id === original.id)).toEqual(original);
  expect(completed.variants.map(row => row.price).sort((a, b) => a - b)).toEqual([8262, 18054]);
});

test('a same-name Tokyo product with no exact source ID cannot absorb either published variant', () => {
  const generic = { ...saboCandidate('generic-sabo', 90000), source: 'shinsoku' };
  const original = compare([generic]).products[0];
  const completed = completeSaboVariants([saboAnniversary, saboSpecial], [generic]);
  expect(completed.result.products).toHaveLength(3);
  expect(completed.result.products.find(product => product.id === original.id)).toEqual(original);
  expect(completed.variants.map(row => row.price).sort((a, b) => a - b)).toEqual([8262, 18054]);
});

test('variant IDs survive a new Oripark run, image URL and source price', () => {
  const initial = completeSaboVariants([saboAnniversary, saboSpecial]);
  const updated = [saboAnniversary, saboSpecial].map((source, i) => ({ ...source,
    id: `next-run-${source.id}`, image_url: `https://example.com/new-${i}.png`,
    raw_import: { ...source.raw_import!, source_price: source.raw_import!.source_price! + 1000 },
  }));
  const next = completeSaboVariants(updated);
  expect(next.variants.map(({ sourceId, productId }) => ({ sourceId, productId })))
    .toEqual(initial.variants.map(({ sourceId, productId }) => ({ sourceId, productId })));
});

test('distinct stable source IDs also separate variants whose imported expansion labels are identical', () => {
  const variants = [saboAnniversary, saboSpecial].map(source => ({ ...source,
    card_name: 'モンキー・D・ルフィ', list_no: 'P-108', tag: 'プロモ',
    raw_import: { ...source.raw_import!, raw_row: { エキスパンション: 'プロモーションカード' } },
  }));
  const first = completeSaboVariants(variants);
  const reversed = completeSaboVariants([...variants].reverse());
  expect(first.result.products).toHaveLength(2);
  expect(reversed.variants).toEqual(first.variants);
});

test('variant image evidence overrides a generic DB image and does not retain its wrong alternate image', () => {
  const { result, report } = completeSaboVariants([saboAnniversary, saboSpecial]);
  const wrongImage = 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/wrong-variant.png';
  const dbRows = result.products.map(product => ({ id: `stale-${product.id}`, store: 'manman-akihabara',
    franchise: product.franchise, card_name: product.name, list_no: product.model_number, grade: 'PSA10',
    tag: '旧タグ', image_url: wrongImage, alt_image_url: wrongImage, image_status: 'alive' }));
  const prepared = buildTokyoPreparedCards('tokyo-run', { products: result.products,
    snapshot: { store: 'manman-akihabara', business_date: '2026-11-16', report: { oripark_coverage: report } } } as any, [], dbRows as any);
  for (const source of [saboAnniversary, saboSpecial]) {
    const item = report.items.find(row => row.oriparkCardId === source.id)!;
    expect(prepared.find(row => row.source_shinsoku_id === item.productId)).toMatchObject({
      image_url: source.image_url, alt_image_url: null, db_card_id: null, tag: source.tag, rarity: source.rarity,
    });
  }
});

test('alternate images alone are insufficient evidence to separate source variants', () => {
  const withoutPrimary = { ...saboSpecial, image_url: null, alt_image_url: 'https://example.com/alt-only.png' };
  expect(() => completeSaboVariants([saboAnniversary, withoutPrimary])).toThrow();
});

test('a raw image bearing another source product ID cannot prove a source variant', () => {
  const mismatched = { ...saboSpecial, raw_import: { ...saboSpecial.raw_import!, raw_row: {
    エキスパンション: 'OP13', 商品ID: saboAnniversary.excel_product_id, 画像: 'https://example.com/mismatched.png',
  } } };
  expect(() => completeSaboVariants([saboAnniversary, mismatched])).toThrow();
});

test('original images linked to exact source IDs distinguish variants even when the DB image is shared', () => {
  const sharedImage = 'https://example.com/shared-wrong-db.png';
  const variants = [saboAnniversary, saboSpecial].map(source => ({ ...source,
    image_url: sharedImage, alt_image_url: sharedImage,
    raw_import: { ...source.raw_import!, raw_row: { ...source.raw_import!.raw_row,
      商品ID: source.excel_product_id, 画像: source.image_url,
    } },
  }));
  const first = completeSaboVariants(variants);
  const reversed = completeSaboVariants([...variants].reverse());
  expect(first.result.products).toHaveLength(2);
  expect(reversed.variants).toEqual(first.variants);
  expect(new Set(first.variants.map(row => row.image)).size).toBe(2);
});

test('an exact source ID retains its product ID but never borrows a generic competitor price for that variant', () => {
  const own = saboCandidate(saboAnniversary.excel_product_id!, 24000);
  const generic = { ...saboCandidate('generic-sabo', 90000), source: 'shinsoku' };
  const original = compare([own, generic]).products.find(product => product.origins.some(origin => origin.id === own.id))!;
  const ownPrice = compare([own]).products[0];
  const { result, variants } = completeSaboVariants([saboAnniversary, saboSpecial], [own, generic]);
  const product = result.products.find(row => row.id === original.id)!;
  expect(variants.find(row => row.sourceId === own.id)).toMatchObject({ productId: original.id, price: 24000 });
  expect(product).toMatchObject({ source_price: 24000, price_high: ownPrice.price_high, price_low: ownPrice.price_low,
    selected_high_source: 'kecak', selected_low_source: 'kecak' });
  expect(product.origins.every(origin => origin.source === 'kecak' && origin.id === own.id)).toBe(true);
  expect(result.priceSources[product.id]).toMatchObject({ price: 24000, source: 'kecak', source_id: own.id });
});

test('already distinct Tokyo variants preserve their metadata despite sharing a generic DB alias', () => {
  const variants = [
    { ...saboAnniversary, card_name: 'サボ(3周年)', alt_image_url: null, db_card: { card_name: 'サボ' } },
    { ...saboSpecial, card_name: 'サボ(SP)', alt_image_url: null, db_card: { card_name: 'サボ' } },
  ];
  const rows = variants.map((source, index) => ({ ...saboCandidate(source.excel_product_id!, 24000 + 10000 * index),
    name: source.card_name, imageUrl: source.image_url,
  }));
  const result = compare(rows);
  const original = JSON.parse(JSON.stringify(result));
  const report = completeOriparkCoverage(result, baseline(variants), '2026-11-16', 1, c => compare([c]));
  expect(result.products).toHaveLength(2);
  expect(result).toEqual(original);
  expect(report.items.every(item => !item.edition)).toBe(true);
  expect(new Set(report.items.map(item => item.productId)).size).toBe(2);
  const prepared = buildTokyoPreparedCards('tokyo-run', { products: result.products,
    snapshot: { store: 'manman-akihabara', business_date: '2026-11-16', report: { oripark_coverage: report } } } as any);
  for (const source of variants) {
    const item = report.items.find(row => row.oriparkCardId === source.id)!;
    expect(prepared.find(row => row.source_shinsoku_id === item.productId)?.image_url).toBe(source.image_url);
  }
});

test('unopened sets already published by Oripark are included without broadening to all unopened items', () => {
  const box = { ...card, card_name: 'ポケモン切手BOX', grade: 'BOX', tag: 'BOX', list_no: null,
    source: 'shinsoku', raw_import: { source_price: 300000, price_source: 'shinsoku' } };
  const result = compare();
  completeOriparkCoverage(result, baseline([box]), '2026-11-16', 1, c => compare([c]));
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ product_type: 'box', name: 'ポケモン切手BOX', selected_high_source: 'shinsoku' });
});

test('expired original prices and zero/invalid original prices cannot silently fill coverage', () => {
  expect(() => completeOriparkCoverage(compare(), baseline(), '2026-11-18', 1, c => compare([c]))).toThrow('鮮度');
  expect(() => completeOriparkCoverage(compare(), baseline([{ ...card, raw_import: { source_price: 0, price_source: 'order_list' } }]),
    '2026-11-16', 1, c => compare([c]))).toThrow('補完できません');
});

test('same model numbers do not collapse different card variants or franchises', () => {
  const product = compare([{ source: 'shinsoku', id: 'variant', franchise: 'Pokemon', name: 'カイ(エラー版)',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]).products[0];
  expect(coverageMatches(card, product)).toBe(false);
  expect(coverageMatches({ ...card, franchise: 'ONE PIECE' }, product)).toBe(false);
});

test('ambiguous identities fail instead of selecting an arbitrary Tokyo product', () => {
  const result = compare([{ source: 'shinsoku', id: 'a', franchise: 'Pokemon', name: 'カイ',
    modelNumber: '236/172', productType: 'PSA10', sourcePrice: 150000 }]);
  result.products.push({ ...result.products[0], id: 'b' });
  expect(() => completeOriparkCoverage(result, baseline(), '2026-11-16', 1, c => compare([c]))).toThrow('複数商品');
});

test('supplemented overridden BOX prices use Shinsoku rates and provenance, not order-list rates', () => {
  const custom = normalizeStorePricingSettings({});
  custom.tokyo_source_discount_rates.kecak = { high: 0.1, low: 0.2 };
  custom.tokyo_source_discount_rates.shinsoku = { high: 0.3, low: 0.4 };
  const compareBox = (rows: any[] = []) => compareTokyoSourceProducts(rows, [], custom, '2026-11-16T02:00:00Z');
  const box: CoverageCard = { ...card, card_name: 'テストBOX', tag: 'BOX', grade: 'BOX', list_no: null,
    raw_import: { source_price: 10000, price_source: 'order_list', raw_row: {
      pokemon_box_price_source: 'BOX_PRICE_DB', pokemon_box_original_order_list_price: 20000,
    } } };
  const result = compareBox();
  completeOriparkCoverage(result, baseline([box]), '2026-11-16', 1, c => compareBox([c]));
  const expected = compareBox([{ source: 'shinsoku', id: box.excel_product_id, franchise: box.franchise,
    name: box.card_name, modelNumber: null, productType: 'BOX', sourcePrice: 10000 }]).products[0];
  expect(result.products[0]).toMatchObject({ source_price: 10000, selected_high_source: 'shinsoku',
    selected_low_source: 'shinsoku', price_high: expected.price_high, price_low: expected.price_low });
  expect(result.products[0].origins[0]).toMatchObject({ source: 'shinsoku', rawPrice: 10000, highRate: 0.3, lowRate: 0.4 });
  const ordinary = { ...box, raw_import: { source_price: 10000, price_source: 'order_list', raw_row: null } };
  const ordinaryResult = compareBox();
  completeOriparkCoverage(ordinaryResult, baseline([ordinary]), '2026-11-16', 1, c => compareBox([c]));
  expect(ordinaryResult.products[0].selected_high_source).toBe('kecak');
  expect(ordinaryResult.products[0].price_high).not.toBe(result.products[0].price_high);
});

test.each(['missing', 'unrecognized'])('BOX override %s cannot silently use the KECAK rate', marker => {
  const box: CoverageCard = { ...card, tag: 'BOX', grade: 'BOX', list_no: null,
    raw_import: { source_price: 10000, price_source: 'order_list', raw_row: { pokemon_box_price_source: marker } } };
  expect(() => completeOriparkCoverage(compare(), baseline([box]), '2026-11-16', 1, c => compare([c])))
    .toThrow('元価格を特定できません');
});


test('published coverage loads and fingerprints price override metadata', async () => {
  const raw = { source_price: 10000, price_source: 'order_list', raw_row: { pokemon_box_price_source: 'BOX_PRICE_DB' } };
  const published = { ...card, raw_import: raw };
  const select = jest.fn();
  const db = { from: (table: string) => {
    const query: any = {};
    for (const method of ['eq', 'not', 'order', 'limit']) query[method] = () => query;
    query.select = (columns: string) => { select(table, columns); return query; };
    query.maybeSingle = async () => ({ data: { id: 'ori-run', order_list_import_id: 'order' } });
    query.single = async () => ({ data: { business_date: '2026-11-16' } });
    query.range = async () => ({ data: table === 'generated_page'
      ? [{ status: 'generated', kind: 'store', card_ids: [card.id] }] : [published] });
    return query;
  } };
  const first = await loadOriparkCoverage(db as any);
  expect(select).toHaveBeenCalledWith('prepared_card', expect.stringContaining('raw_import(source_price,price_source,raw_row)'));
  expect(first.cards[0].raw_import?.raw_row).toEqual(raw.raw_row);
  raw.raw_row.pokemon_box_price_source = 'missing';
  const changed = await loadOriparkCoverage(db as any);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});
