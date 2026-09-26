import { galleryDownloadList, latestRunImages } from '../lib/download-images';

test('一括DL対象を入力順に関係なく最新Runだけに絞る', () => {
  const images = [
    { id: 'old-1', run_id: 'old', run_started_at: '2026-08-22T02:42:16.000Z' },
    { id: 'new-1', run_id: 'new', run_started_at: '2026-08-22T11:41:55.000Z' },
    { id: 'old-2', run_id: 'old', run_started_at: '2026-08-22T02:42:16.000Z' },
    { id: 'new-2', run_id: 'new', run_started_at: '2026-08-22T11:41:55.000Z' },
  ];

  expect(latestRunImages(images).map(image => image.id)).toEqual(['new-1', 'new-2']);
  expect(latestRunImages([])).toEqual([]);
});

test('同名ページ（東京 Pokemon「その他」×2）もZIP内で上書きされない一意なファイル名になる', () => {
  const page = (page_label: string, page_index: number) => ({ franchise: 'Pokemon', page_label, page_index, image_url: `https://x/${page_index}.png` });
  const names = galleryDownloadList([page('その他', 26), page('その他-2', 27), page('その他-3', 28), page('その他', 29), page('AR/SAR', 16),
    { franchise: 'Pokemon', page_label: 'BOX', page_index: 30, image_url: null }]).map(item => item.filename);
  expect(names).toEqual(['Pokemon_その他.png', 'Pokemon_その他-2.png', 'Pokemon_その他-3.png', 'Pokemon_その他_2.png', 'Pokemon_AR-SAR.png']);
  expect(new Set(names).size).toBe(names.length);
});
