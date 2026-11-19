import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralDiagnostic } from './diagnostic.mjs';

const fixture = () => ({ site: { module: 'lib/oripark-coverage', line: 132, function: 'completeOriparkCoverage' }, input: {
  baseline: { cards: ['PRIVATE_ID_A', 'PRIVATE_ID_B'].map((id, index) => ({ card_name: 'PRIVATE_CARD_NAME', list_no: 'PRIVATE_MODEL',
    franchise: 'ONE PIECE', grade: 'PSA10', tag: 'パラレル', excel_product_id: id,
    image_url: `https://private.test/${id}?secret=PRIVATE_TOKEN`, alt_image_url: 'https://private.test/shared',
    raw_import: { source_price: index ? 18054 : 8262, raw_row: { 商品ID: id,
      画像: `https://private.test/${id}`, エキスパンション: `PRIVATE_EXPANSION_${index}`, arbitrary: 'PRIVATE_LOG' } },
  })) },
  snapshot: { report: { oripark_coverage: { items: ['a', 'b'].map(id => ({ productId: 'PRIVATE_PRODUCT', imageUrl: `https://private.test/${id}` })) } } },
  preCoverage: { products: [{ name: null, model_number: 13, origins: null }, { name: '', origins: [{ rawPrice: 100, sourcePrice: null }] }] },
} });

test('edition collisions expose relation counts without any source values', () => {
  const result = structuralDiagnostic(fixture());
  assert.equal(result.coverageIdentity.duplicateNameModelGroups, 1);
  assert.deepEqual(result.coverageIdentity.groupShapes, [{ groups: 1, rows: 2, sourceIds: 2, sourcePrices: 2,
    primaryImages: 2, originalImages: 2, expansions: 2, rowsWithExactSourceMatch: 0, existingExactSourceProducts: 0,
    rawSourceIdMatches: 2, rawSourceIdMismatches: 0, differingPrimaryAltRows: 2 }]);
  assert.equal(result.coverageIdentity.sharedPreparedProductWithDifferentImages, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private\.test|https:|8262|18054/);
  assert.deepEqual(result.site, { module: 'lib/oripark-coverage', line: 132, function: 'completeOriparkCoverage' });
});
test('unknown TypeError diagnostics distinguish null, absent, incorrect type and empty fields', () => {
  const result = structuralDiagnostic(fixture());
  assert.equal(result.fieldTypes.products.name.null, 1);
  assert.equal(result.fieldTypes.products.name.emptyString, 1);
  assert.equal(result.fieldTypes.products.model_number.number, 1);
  assert.equal(result.fieldTypes.products.model_number.missing, 1);
  assert.equal(result.fieldTypes.products.origins.null, 1);
  assert.equal(result.fieldTypes.origins.sourcePrice.null, 1);
});
test('diagnostics do not infer editions or associate distinct names and grades', () => {
  const value = fixture(); value.input.baseline.cards[1].card_name = 'ANOTHER_PRIVATE_CARD';
  assert.equal(structuralDiagnostic(value).coverageIdentity.duplicateNameModelGroups, 0);
  value.input.baseline.cards[1].card_name = value.input.baseline.cards[0].card_name;
  value.input.baseline.cards[1].grade = 'BOX';
  assert.equal(structuralDiagnostic(value).coverageIdentity.duplicateNameModelGroups, 0);
});
test('invalid site values and free text are omitted; arbitrary missing inputs remain safe', () => {
  const value = fixture(); value.site.function = 'PRIVATE_INJECTED_FUNCTION';
  assert.equal(structuralDiagnostic(value).site.function, undefined);
  value.site.module = '__proto__';
  assert.equal(structuralDiagnostic(value).site, undefined);
  assert.equal(structuralDiagnostic(null).coverageIdentity.duplicateNameModelGroups, 0);
  assert.doesNotMatch(JSON.stringify(structuralDiagnostic({ input: { baseline: { cards: [null, 3, 'PRIVATE_LOG'] } } })), /PRIVATE/);
});
test('summaries are deterministic under input order changes and do not mutate fixture', () => {
  const value = fixture(), before = JSON.stringify(value), expected = structuralDiagnostic(value);
  assert.equal(JSON.stringify(value), before);
  value.input.baseline.cards.reverse();
  assert.deepEqual(structuralDiagnostic(value), expected);
});
test('already independent exact-source products are distinguishable from collapsed edition matches', () => {
  const value = fixture();
  value.input.preCoverage.products = value.input.baseline.cards.map((card, index) => ({ id: `PRIVATE_PRODUCT_${index}`,
    origins: [{ source: 'kecak', id: card.excel_product_id }] }));
  const shape = structuralDiagnostic(value).coverageIdentity.groupShapes[0];
  assert.equal(shape.rowsWithExactSourceMatch, 2);
  assert.equal(shape.existingExactSourceProducts, 2);
  value.input.preCoverage.products[1].id = value.input.preCoverage.products[0].id;
  assert.equal(structuralDiagnostic(value).coverageIdentity.groupShapes[0].existingExactSourceProducts, 1);
});
