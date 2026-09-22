import { normalizeStorePricingSettings, type DbCardRow } from '@haraka/shared';
import { findHarakaImage, harakaImageUrl, loadTokyoHarakaCards } from '../lib/haraka-card-images';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards';

const url = 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/a.png';
const alternate = 'https://www.pokemon-card.com/assets/images/card_images/large/SV/a.jpg';
const row = (patch: Partial<DbCardRow> = {}): DbCardRow => ({ id: 'db-1', store: 'manman-akihabara', franchise: 'Pokemon',
  card_name: 'マリオピカチュウ（大）', grade: 'PSA10', list_no: '294/XY-P', image_url: url, alt_image_url: null,
  image_status: null, ...patch } as DbCardRow);
const product = { id: 'source-1', franchise: 'Pokemon', name: 'マリオピカチュウ', model_number: '294/XY-P', product_type: 'psa' };

test('full number and relaxed name match raw image; name-only or numerator-only never adopts', () => {
  expect(findHarakaImage(product, [row()])).toMatchObject({ status: 'matched', imageUrl: url, dbCardId: 'db-1' });
  for (const list_no of ['', '294/SM-P', '293/XY-P']) {
    expect(findHarakaImage(product, [row({ list_no })])).toMatchObject({ status: 'ambiguous', imageUrl: null });
  }
  expect(findHarakaImage({ ...product, model_number: null }, [row()])).toMatchObject({ status: 'ambiguous', imageUrl: null });
  expect(findHarakaImage({ ...product, name: '別商品' }, [row()]).status).toBe('missing');
});

test('exact identity wins; relaxed variants with different URLs require review, identical URL deduplicates', () => {
  const exact = row({ id: 'exact', card_name: product.name });
  const variant = row({ id: 'variant', card_name: product.name + '(収録弾)', image_url: alternate });
  expect(findHarakaImage(product, [exact, variant]).dbCardId).toBe('exact');
  expect(findHarakaImage(product, [row(), variant]).status).toBe('ambiguous');
  expect(findHarakaImage(product, [row(), { ...variant, image_url: url }]).status).toBe('matched');
});

test('normalization handles PSA markers, whitespace, rarity but preserves GX/VMAX and complete numbers', () => {
  expect(findHarakaImage({ ...product, name: 'レックウザVMAX', model_number: '252/184' }, [row({ card_name: '【PSA10】 レックウザＶＭＡＸ HRSA', list_no: '252 / 184' })]).status).toBe('matched');
  expect(findHarakaImage({ ...product, name: 'レックウザGX', model_number: '252/184' }, [row({ card_name: 'レックウザVMAX HRSA', list_no: '252/184' })]).status).toBe('missing');
});

test('Tokyo, franchise and grade boundaries reject other shops or single cards', () => {
  for (const patch of [{ store: 'manman' }, { store: 'oripark' }, { franchise: 'ONE PIECE' }, { grade: 'PSA9' }, { grade: 'PSA11' }, { grade: '' }, { grade: 'BOX' }]) {
    expect(findHarakaImage(product, [row(patch)]).status).toBe('missing');
  }
});

test('single-card DB images are eligible for PSA display without changing target grade or price', () => {
  expect(findHarakaImage(product, [row({ grade: 'シングル' })]).status).toBe('matched');
  const result = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-07' }, products: [{ ...product, price_high: 9000, price_low: 9000 }] } as any;
  expect(buildTokyoPreparedCards('run', result, [], [row({ grade: 'シングル' })])[0])
    .toMatchObject({ image_url: url, grade: 'PSA10', tag: 'PSA10', price_high: 9000, price_low: 9000 });
});

test.each([
  ['ピカチュウ(マスターボールミラー)', 'ピカチュウ(モンスターボールミラー)'],
  ['ピカチュウ(別イラスト)', 'ピカチュウ(通常イラスト)'],
  ['ピカチュウ(マスターボールミラー)', 'ピカチュウ'],
])('explicit target variant is never erased: %s / %s', (name, card_name) => {
  expect(findHarakaImage({ ...product, name }, [row({ card_name })])).toMatchObject({ status: 'ambiguous', imageUrl: null });
});

test('matching target annotations remain usable while generic rarity notes are removable', () => {
  expect(findHarakaImage({ ...product, name: 'ピカチュウ(マスターボールミラー)' }, [row({ card_name: 'ピカチュウ(マスターボールミラー)(収録)' })]).status).toBe('matched');
  expect(findHarakaImage({ ...product, name: 'ピカチュウ(SAR)' }, [row({ card_name: 'ピカチュウ' })]).status).toBe('matched');
});

test('BOX normalizer matches prefixes but contradictory nonempty model numbers require review', () => {
  const box = { ...product, franchise: 'ONE PIECE', name: 'OP04 謀略の王国', model_number: null, product_type: 'box' };
  const dbBox = row({ franchise: 'ONE PIECE', card_name: '[1BOX]謀略の王国', grade: 'BOX', list_no: '' });
  expect(findHarakaImage(box, [dbBox]).status).toBe('matched');
  expect(findHarakaImage({ ...box, model_number: 'OP04' }, [{ ...dbBox, list_no: 'OP05' }]).status).toBe('ambiguous');
});

test('image URL selection prefers valid alt, rejects dead primary, private paths, pages, credentials and unknown hosts', () => {
  expect(harakaImageUrl(row({ alt_image_url: alternate, image_status: 'dead' }))).toBe(alternate);
  expect(harakaImageUrl(row({ image_status: 'dead' }))).toBeNull();
  for (const bad of ['http://www.pokemon-card.com/assets/images/a.png', 'https://user:pass@www.pokemon-card.com/assets/images/a.png',
    'https://snkrdunk.com/apparels/123', 'https://evil.test/a.png', url.replace('/public/', '/authenticated/'),
    'https://www.pokemon-card.com/login/a.png', 'https://www.pokemon-card.com/assets/images/card_images/large/WCP/a.gif',
    'https://encrypted-tbn1.gstatic.com/shopping?q=x']) {
    expect(harakaImageUrl(row({ image_url: bad }))).toBeNull();
  }
  expect(harakaImageUrl(row({ alt_image_url: 'https://evil.test/a.png' }))).toBe(url);
});

test('loader scopes and paginates beyond 1000 records, errors are not treated as empty data', async () => {
  const range = jest.fn(async (offset: number) => ({ data: offset === 0 ? Array.from({ length: 1000 }, () => row()) : [row()], error: null }));
  const order = jest.fn(() => ({ range })); const eq = jest.fn(() => ({ order }));
  const db = { from: jest.fn(() => ({ select: () => ({ eq }) })) };
  expect(await loadTokyoHarakaCards(db as any)).toHaveLength(1001);
  expect(eq).toHaveBeenCalledWith('store', 'manman-akihabara');
  expect(order).toHaveBeenCalledWith('id');
  expect(range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  range.mockImplementation(async () => ({ data: null, error: { message: 'failure' } } as any));
  await expect(loadTokyoHarakaCards(db as any)).rejects.toThrow('failure');
});

test('mapper chooses Haraka DB image and provenance without changing snapshot prices', () => {
  const snapshot = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-07' }, products: [{ ...product, price_high: 9000, price_low: 9000, image_url: 'https://example.com/slab.png' }] } as any;
  const [prepared] = buildTokyoPreparedCards('run', snapshot, [], [row()]);
  expect(prepared).toMatchObject({ db_card_id: 'db-1', image_url: url, alt_image_url: null, source_shinsoku_id: 'source-1', price_high: 9000, price_low: 9000, price_source: 'shinsoku' });
});

test('Tokyo inherits same-card tag consensus independently from image adoption and rejects review-only identity', () => {
  const snapshot = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-08' }, products: [{ ...product, price_high: 9000, price_low: 9000 }] } as any;
  const prepare = (cards: DbCardRow[]) => buildTokyoPreparedCards('run', snapshot, [], cards)[0];
  expect(prepare([row({ tag: 'ピカチュウ/プロモ' })])).toMatchObject({ tag: 'ピカチュウ/プロモ', grade: 'PSA10', price_high: 9000, price_low: 9000 });
  const two = [row({ tag: 'ピカチュウ' }), row({ id: 'db-2', card_name: 'マリオピカチュウ（小）', tag: 'ピカチュウ', image_url: alternate })];
  expect(prepare(two)).toMatchObject({ tag: 'ピカチュウ', image_url: null, db_card_id: null });
  expect(prepare([two[0], { ...two[1], tag: 'プロモ' }])).toMatchObject({ tag: 'PSA10', image_url: null });
  expect(prepare([two[0], { ...two[1], tag: null }])).toMatchObject({ tag: 'PSA10', image_url: null });
  expect(prepare([row({ tag: 'ピカチュウ', list_no: '293/XY-P' })])).toMatchObject({ tag: 'PSA10', image_url: null });
  expect(prepare([row({ tag: 'ピカチュウ', image_url: null })])).toMatchObject({ tag: 'ピカチュウ', image_url: null });
  expect(prepare([row({ tag: 'ピカチュウ', store: 'manman' })])).toMatchObject({ tag: 'PSA10', image_url: null });
});

test('Tokyo reviewed Yugioh IDs use existing tags only, preserve fallback and BOX identity', () => {
  const snapshot = { snapshot: { store: 'manman-akihabara', business_date: '2026-09-08', settings: normalizeStorePricingSettings({}) }, products: [
    { ...product, franchise: 'YU-GI-OH!', id: 'IAX2600000774', model_number: null, price_high: 9000, price_low: 9000 },
    { ...product, franchise: 'YU-GI-OH!', id: 'IAX2600000407', model_number: null, price_high: 9000, price_low: 9000 },
    { ...product, franchise: 'YU-GI-OH!', id: 'unknown', price_high: 9000, price_low: 9000 },
    { ...product, franchise: 'Pokemon', id: 'IAX2600000407', price_high: 9000, price_low: 9000 },
    { ...product, franchise: 'YU-GI-OH!', id: 'IAX2600000407', product_type: 'box', price_high: 9000, price_low: 9000, source_price: 10000 },
  ] } as any;
  expect(buildTokyoPreparedCards('run', snapshot).map(p => p.tag)).toEqual(['モンスター', '青眼/他言語', 'PSA10', 'PSA10', 'BOX']);
});
