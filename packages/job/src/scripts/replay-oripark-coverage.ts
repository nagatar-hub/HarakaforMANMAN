import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts } from '../jobs/tokyo-buyback-sync.js';
import { completeOriparkCoverage, assertOriparkCoverage } from '../lib/oripark-coverage.js';
import { buildTokyoPreparedCards } from '../lib/tokyo-normal-cards.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const settings = normalizeStorePricingSettings(input.snapshot.settings);
const original = new Map(input.products.map((p: { id: string }) => [p.id, JSON.stringify(p)]));
const result = { products: input.products, unmatched: [], priceSources: {} } as ReturnType<typeof compareTokyoSourceProducts>;
const coverage = completeOriparkCoverage(result, input.baseline, input.snapshot.business_date,
  settings.tokyo_price_max_age_days, candidate => compareTokyoSourceProducts([candidate], [], settings, input.snapshot.fetched_at));
for (const product of result.products) if (original.has(product.id) && original.get(product.id) !== JSON.stringify(product)) throw new Error(`既存商品を変更: ${product.id}`);
const snapshot = { ...input.snapshot, report: { ...input.snapshot.report, oripark_coverage: coverage } };
const cards = buildTokyoPreparedCards('replay', { snapshot, products: result.products }, input.mappings, input.dbRows);
assertOriparkCoverage(coverage, cards.filter(card => card.image_url || card.alt_image_url) as any);
const output = { baseline: coverage.items.length, originalProducts: original.size, products: cards.length,
  withImages: cards.filter(card => card.image_url || card.alt_image_url).length,
  missingCoverage: 0, existingProductsUnchanged: true };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ output, coverage, cards }, null, 2));
console.log(JSON.stringify(output));
