import { isBuiltInOrderListExclusion } from '../utils/order-list-exclusion';

describe('isBuiltInOrderListExclusion', () => {
  it('先頭装飾と半角・全角空白を正規化する', () => {
    expect(isBuiltInOrderListExclusion('なにかのPSA10')).toBe(true);
    expect(isBuiltInOrderListExclusion('【対象外】 なにかの PSA10')).toBe(true);
    expect(isBuiltInOrderListExclusion('【対象外】　なにかの　P S A 1 0　')).toBe(true);
  });

  it('部分一致や似た商品名は除外しない', () => {
    expect(isBuiltInOrderListExclusion('なにかのPSA10カード')).toBe(false);
    expect(isBuiltInOrderListExclusion('なにかのPSA100')).toBe(false);
    expect(isBuiltInOrderListExclusion('ピカチュウ PSA10')).toBe(false);
    expect(isBuiltInOrderListExclusion(null)).toBe(false);
  });
});
