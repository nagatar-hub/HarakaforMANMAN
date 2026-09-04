import { createDemandTextSvg, demandUnitForCard } from '../lib/image-composer';

test('募集数を下段に表示し、BOXだけ個単位にする', () => {
  expect(createDemandTextSvg({ demand: 12, width: 200, height: 40, fontSize: 18 }).toString())
    .toContain('12枚募集！');
  expect(createDemandTextSvg({ demand: 3, unit: '個', width: 200, height: 40, fontSize: 18 }).toString())
    .toContain('3個募集！');
  expect(demandUnitForCard({ grade: 'BOX', tag: 'BOX' })).toBe('個');
  expect(demandUnitForCard({ grade: 'PSA10', tag: null })).toBe('枚');
});
