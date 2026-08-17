import { formatGalleryCardList } from '../lib/gallery-card-list';

test('画像内のカードを名称・型番・金額の一覧にする', () => {
  expect(formatGalleryCardList([
    { card_name: 'ピカチュウ', list_no: 'SV2a 025/165', price_high: 120000 },
    { card_name: 'BOX商品', list_no: null, price_high: 9800 },
  ])).toBe('ピカチュウ(SV2a 025/165) ￥120,000\nBOX商品 ￥9,800');
});
