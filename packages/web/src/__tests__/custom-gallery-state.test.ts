import type { CustomBuybackSheetRow } from '@haraka/shared';
import { groupCustomGalleryEntries, type CustomGalleryEntry } from '../app/gallery/custom/custom-gallery-state';

function entry(id: string, displayDate: string, updatedAt: string): CustomGalleryEntry {
  const sheet = {
    id, store: 'oripark', name: id, franchise: 'Pokemon', product_type: 'psa', kind: 'store',
    price_snapshot_run_id: 'run-1', price_business_date: '2026-08-03', display_date: displayDate,
    status: 'draft', revision: 0, last_rendered_revision: null, error_message: null, created_by: null,
    created_at: '2026-08-03T00:00:00Z', updated_at: updatedAt,
  } satisfies CustomBuybackSheetRow;
  return { sheet, pages: [] };
}

test('custom gallery groups by editable display date and keeps newest dates first', () => {
  const groups = groupCustomGalleryEntries([
    entry('old', '2026-08-03', '2026-08-03T01:00:00Z'),
    entry('newer-a', '2026-08-05', '2026-08-05T01:00:00Z'),
    entry('newer-b', '2026-08-05', '2026-08-05T02:00:00Z'),
  ]);
  expect(groups.map((group) => group.date)).toEqual(['2026-08-05', '2026-08-03']);
  expect(groups[0].entries.map((row) => row.sheet.id)).toEqual(['newer-b', 'newer-a']);
});
