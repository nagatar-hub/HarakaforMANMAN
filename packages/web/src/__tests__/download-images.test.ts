import { latestRunImages } from '../lib/download-images';

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
