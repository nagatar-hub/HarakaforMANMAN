import {
  NEW_CARD_ALLOWED_IMAGE_HOSTS,
  newCardAltImageUrlOrNull,
} from '../app/runs/order-list-new-card-validation';

test('代替画像は空欄または許可済みHTTPSホストだけを受け付ける', () => {
  expect(newCardAltImageUrlOrNull('  ')).toBeNull();
  expect(newCardAltImageUrlOrNull(
    'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/a.png',
  )).toContain(NEW_CARD_ALLOWED_IMAGE_HOSTS[0]);
  expect(newCardAltImageUrlOrNull(
    'https://firebasestorage.googleapis.com/v0/b/cards/o/a.png',
  )).toContain(NEW_CARD_ALLOWED_IMAGE_HOSTS[1]);
});

test.each([
  'http://fexadnveyuqduiujewrc.supabase.co/a.png',
  'https://fexadnveyuqduiujewrc.supabase.co:444/a.png',
  'https://fexadnveyuqduiujewrc.supabase.co.evil.example/a.png',
  'https://127.0.0.1/a.png',
])('危険または未許可の代替画像URLを拒否する: %s', (url) => {
  expect(() => newCardAltImageUrlOrNull(url)).toThrow(/許可ホスト/);
});
