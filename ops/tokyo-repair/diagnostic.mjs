// Only structural counts and repository constants leave the private fixture boundary.
// Group keys and source values stay local; even malformed input is never echoed.
const MAX_ROWS = 20000;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const rows = value => Array.isArray(value) ? value.slice(0, MAX_ROWS) : [];
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
const functions = {
  'lib/tokyo-normal-cards': ['buildTokyoPreparedCards', 'loadTokyoCardImageMappings'],
  'lib/oripark-coverage': ['loadOriparkCoverage', 'coverageMatches', 'completeOriparkCoverage', 'readCoverageReport', 'assertOriparkCoverage'],
  'lib/haraka-card-images': ['harakaImageUrl', 'findHarakaImage', 'loadTokyoHarakaCards'],
  'lib/page-planner': ['planPages'],
  'jobs/generate': ['planTokyoGalleryPages'],
};

function types(values) {
  const result = { missing: 0, null: 0, string: 0, number: 0, boolean: 0, array: 0, object: 0, other: 0,
    emptyString: 0, nonFiniteNumber: 0 };
  for (const value of values) {
    const type = value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array'
      : ['string', 'number', 'boolean', 'object'].includes(typeof value) ? typeof value : 'other';
    result[type]++;
    if (typeof value === 'string' && !value.trim()) result.emptyString++;
    if (typeof value === 'number' && !Number.isFinite(value)) result.nonFiniteNumber++;
  }
  return result;
}
function profile(values, fields) {
  return Object.fromEntries(fields.map(field => [field, types(values.map(value => {
    let cursor = value;
    for (const key of field.split('.')) cursor = record(cursor)[key];
    return cursor;
  }))]));
}
function groups(values, keyOf) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyOf(record(value));
    if (key !== null) {
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(record(value));
    }
  }
  return [...grouped.values()].filter(group => group.length > 1);
}
function unique(values) { return new Set(values.filter(value => text(value) !== null || typeof value === 'number' && Number.isFinite(value))).size; }
function collisionShape(group, exactProducts) {
  const raw = card => record(record(card.raw_import).raw_row);
  return {
    rows: group.length,
    sourceIds: unique(group.map(card => card.excel_product_id)),
    sourcePrices: unique(group.map(card => record(card.raw_import).source_price)),
    primaryImages: unique(group.map(card => card.image_url)),
    originalImages: unique(group.map(card => raw(card)['画像'])),
    expansions: unique(group.map(card => raw(card)['エキスパンション'])),
    rowsWithExactSourceMatch: group.filter(card => exactProducts.has(card.excel_product_id)).length,
    existingExactSourceProducts: new Set(group.flatMap(card => [...(exactProducts.get(card.excel_product_id) ?? [])])).size,
    rawSourceIdMatches: group.filter(card => text(card.excel_product_id) !== null && raw(card)['商品ID'] === card.excel_product_id).length,
    rawSourceIdMismatches: group.filter(card => raw(card)['商品ID'] != null && raw(card)['商品ID'] !== card.excel_product_id).length,
    differingPrimaryAltRows: group.filter(card => text(card.image_url) !== null && text(card.alt_image_url) !== null && card.image_url !== card.alt_image_url).length,
  };
}

export function structuralDiagnostic(fixture) {
  const input = record(record(fixture).input), pre = record(input.preCoverage);
  const products = rows(pre.products ?? input.products), baseline = rows(record(input.baseline).cards);
  const coverage = rows(record(record(input.snapshot).report).oripark_coverage?.items);
  const cards = rows(input.cards), layouts = rows(input.layouts), mappings = rows(input.imageMappings), dbCards = rows(input.dbCards);
  const origins = [], exactProducts = new Map();
  for (const product of products) {
    for (const origin of rows(record(product).origins)) {
      if (origins.length < MAX_ROWS) origins.push(origin);
      const source = record(origin), productId = text(record(product).id), sourceId = text(source.id);
      if (source.source === 'kecak' && sourceId !== null && productId !== null) {
        if (!exactProducts.has(sourceId)) exactProducts.set(sourceId, new Set());
        exactProducts.get(sourceId).add(productId);
      }
    }
  }
  const nameModelGroups = groups(baseline, card => {
    const name = text(card.card_name), model = text(card.list_no), franchise = text(card.franchise);
    if (name === null || model === null || franchise === null) return null;
    // Exact normalized names only; no fuzzy association and no inferred edition.
    return JSON.stringify([franchise, card.tag === 'BOX' || /BOX/i.test(text(card.grade) ?? '') ? 'BOX' : 'PSA10',
      name.normalize('NFKC').trim().replace(/\s+/g, ' '), model.normalize('NFKC').trim()]);
  });
  const shapes = new Map();
  for (const group of nameModelGroups) {
    const shape = collisionShape(group, exactProducts), key = JSON.stringify(shape);
    const previous = shapes.get(key);
    if (previous) previous.groups++; else shapes.set(key, { groups: 1, ...shape });
  }
  const sharedProducts = groups(coverage, item => text(item.productId));
  const result = {
    schemaVersion: 1,
    coverageIdentity: {
      duplicateNameModelGroups: nameModelGroups.length,
      duplicateNameModelRows: nameModelGroups.reduce((count, group) => count + group.length, 0),
      // Shapes are sorted by numeric properties, never by a hidden name/ID.
      groupShapes: [...shapes.values()].sort((a, b) => b.groups - a.groups || a.rows - b.rows
        || JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, 32),
      groupShapesTruncated: shapes.size > 32,
      sharedPreparedProductGroups: sharedProducts.length,
      sharedPreparedProductWithDifferentImages: sharedProducts.filter(group => unique(group.map(item => item.imageUrl)) > 1).length,
    },
    fieldTypes: {
      products: profile(products, ['name', 'model_number', 'product_type', 'image_url', 'source_price', 'price_high', 'price_low', 'origins']),
      origins: profile(origins, ['id', 'name', 'modelNumber', 'productType', 'rawPrice', 'sourcePrice', 'imageUrl']),
      baseline: profile(baseline, ['card_name', 'list_no', 'grade', 'tag', 'image_url', 'alt_image_url', 'excel_product_id',
        'db_card', 'db_card.card_name', 'raw_import', 'raw_import.source_price', 'raw_import.raw_row',
        'raw_import.raw_row.商品ID', 'raw_import.raw_row.画像', 'raw_import.raw_row.エキスパンション']),
      cards: profile(cards, ['card_name', 'grade', 'tag', 'list_no', 'price_high', 'price_low']),
      layouts: profile(layouts, ['kind', 'franchise', 'total_slots', 'priority', 'is_active']),
      mappings: profile(mappings, ['image_url', 'evidence']),
      dbCards: profile(dbCards, ['card_name', 'list_no', 'tag', 'image_url', 'alt_image_url']),
    },
    rowsTruncated: [pre.products ?? input.products, record(input.baseline).cards, input.cards, input.layouts,
      input.imageMappings, input.dbCards].some(value => Array.isArray(value) && value.length > MAX_ROWS)
      || products.reduce((count, product) => count + (Array.isArray(record(product).origins) ? record(product).origins.length : 0), 0) > MAX_ROWS,
  };
  const site = record(record(fixture).site);
  if (Object.hasOwn(functions, site.module) && Number.isSafeInteger(site.line) && site.line > 0 && site.line < 20000) {
    result.site = { module: site.module, line: site.line,
      ...(functions[site.module].includes(site.function) ? { function: site.function } : {}) };
  }
  return result;
}
