import { parseTargets } from '../scripts/scrape-tcgmp';

test('CLI accepts identity/search metadata only, never prices or an automatic approval', () => {
  const target = { id: 'IAO2600001197', franchise: 'ONE PIECE', name: 'レベッカ', model_number: 'OP05-091' };
  expect(parseTargets([{ ...target, price: 1, approved: true }])).toEqual([target]);
  for (const input of [[], [target, target], [{ ...target, id: '../write' }],
    [{ ...target, franchise: 'unknown' }], [{ ...target, query: '' }], [{ ...target, model_number: 9 }]]) {
    expect(() => parseTargets(input)).toThrow();
  }
});
