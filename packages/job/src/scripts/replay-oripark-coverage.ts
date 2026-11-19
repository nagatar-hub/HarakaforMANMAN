import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync.js';
import { completeOriparkCoverage, assertOriparkCoverage } from '../lib/oripark-coverage.js';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const settings = normalizeStorePricingSettings(input.snapshot.settings);
type Product = ReturnType<typeof compareTokyoSourceProducts>['products'][number];
const original = new Map<string, Product>(input.products.map((product: Product) => [product.id, structuredClone(product)]));
const result = { products: input.products, unmatched: [], priceSources: Object.fromEntries(input.products.map((product: Product) => [product.id, {
  source: product.selected_high_source, source_id: product.origins.find(origin => origin.source === product.selected_high_source)?.id,
  price: product.source_price,
}])) } as ReturnType<typeof compareTokyoSourceProducts>;
const coverage = completeOriparkCoverage(result, input.baseline, input.snapshot.business_date,
  settings.tokyo_price_max_age_days, candidate => compareTokyoSourceProducts([candidate], [], settings, input.snapshot.fetched_at));
let updatedEditions = 0;
let repricedEditions = 0;
for (const [id, previous] of original) {
  const product = result.products.find(row => row.id === id);
  if (!product) throw new Error(`既存商品IDが欠落: ${id}`);
  const evidence = coverage.items.find(item => item.productId === id && item.edition);
  let expected = previous;
  if (evidence?.edition) {
    const edition = evidence.edition;
    const own = previous.origins.filter(origin => origin.source === 'kecak' && origin.id === edition.sourceProductId);
    if (own.length !== 1) throw new Error(`既存別版の元商品IDが不明: ${id}`);
    if (previous.origins.length !== own.length) {
      const origin = own[0];
      const specific = compareTokyoSourceProducts([{ source: origin.source, id: origin.id, franchise: origin.franchise,
        name: edition.name, modelNumber: origin.modelNumber, productType: origin.productType,
        observedAt: origin.observedAt, sourcePrice: origin.rawPrice }],
        [], settings, input.snapshot.fetched_at);
      if (specific.products.length !== 1) throw new Error(`既存別版の元価格再計算失敗: ${id}`);
      expected = { ...specific.products[0], id };
      repricedEditions++;
    }
    expected = { ...expected, name: edition.name, image_url: evidence.imageUrl };
    updatedEditions++;
  }
  if (!isDeepStrictEqual(product, expected)) throw new Error(`既存商品に許可されない変更: ${id}`);
  const selected = product.origins.find(origin => origin.source === product.selected_high_source);
  const recorded = result.priceSources[id];
  if (!selected || recorded?.source !== selected.source || recorded.source_id !== selected.id || recorded.price !== product.source_price) {
    throw new Error(`既存商品の価格出典が不一致: ${id}`);
  }
}
const snapshot = { ...input.snapshot, report: { ...input.snapshot.report, price_sources: result.priceSources, oripark_coverage: coverage } };
const cards = buildTokyoPreparedCards('replay', { snapshot, products: result.products }, input.mappings, input.dbRows);
assertOriparkCoverage(coverage, cards.filter(card => card.image_url || card.alt_image_url) as any);
const output = { baseline: coverage.items.length, originalProducts: original.size, products: cards.length,
  withImages: cards.filter(card => card.image_url || card.alt_image_url).length,
  missingCoverage: 0, existingProductsValidated: true, existingEditionMetadataUpdated: updatedEditions,
  existingEditionsRepricedWithoutGenericOrigins: repricedEditions };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ output, coverage, cards }, null, 2));
console.log(JSON.stringify(output));
