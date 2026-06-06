import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRunIdsForJstDate,
  summarizeGalleryDates,
} from '../lib/gallery-utils';

describe('gallery date utilities', () => {
  const runs = [
    { id: 'run-new', started_at: '2026-06-06T07:13:56.824Z' },
    { id: 'run-old', started_at: '2026-06-06T05:53:45.183Z' },
    { id: 'run-prev-day', started_at: '2026-06-05T02:40:52.491Z' },
  ];

  const pages = [
    { run_id: 'run-new', franchise: 'ONE PIECE' },
    { run_id: 'run-new', franchise: 'YU-GI-OH!' },
    { run_id: 'run-old', franchise: 'ONE PIECE' },
    { run_id: 'run-prev-day', franchise: 'Pokemon' },
  ];

  it('同じJST日付に複数runがある場合は最新だけに絞らず全runを日付一覧へ集計する', () => {
    assert.deepEqual(summarizeGalleryDates(runs, pages), [
      {
        date: '2026-06-06',
        franchises: {
          'ONE PIECE': 2,
          'YU-GI-OH!': 1,
        },
      },
      {
        date: '2026-06-05',
        franchises: {
          Pokemon: 1,
        },
      },
    ]);
  });

  it('指定日の画像一覧用run idは同じJST日付のrunをすべて返す', () => {
    assert.deepEqual(getRunIdsForJstDate(runs, '2026-06-06'), ['run-new', 'run-old']);
  });
});
