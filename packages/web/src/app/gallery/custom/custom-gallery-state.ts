import type { CustomBuybackPageRow, CustomBuybackSheetRow } from '@haraka/shared';

export type CustomGalleryPage = Pick<
  CustomBuybackPageRow,
  'id' | 'sheet_id' | 'page_index' | 'image_url' | 'status'
>;

export type CustomGalleryEntry = {
  sheet: CustomBuybackSheetRow;
  pages: CustomGalleryPage[];
};

export type CustomGalleryDateGroup = {
  date: string;
  entries: CustomGalleryEntry[];
};

export function groupCustomGalleryEntries(entries: CustomGalleryEntry[]): CustomGalleryDateGroup[] {
  const groups = new Map<string, CustomGalleryEntry[]>();
  for (const entry of entries) {
    groups.set(entry.sheet.display_date, [...(groups.get(entry.sheet.display_date) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, rows]) => ({
      date,
      entries: [...rows].sort((left, right) => right.sheet.updated_at.localeCompare(left.sheet.updated_at)),
    }));
}
