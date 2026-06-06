export type GalleryRunRow = {
  id: string;
  started_at: string;
};

export type GalleryDatePageRow = {
  run_id: string;
  franchise: string;
};

export type GalleryDateSummary = {
  date: string;
  franchises: Record<string, number>;
};

export function jstDateString(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export function utcRangeForJstDate(date: string): { from: string; to: string } {
  const from = new Date(`${date}T00:00:00+09:00`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function getRunIdsForJstDate(runs: GalleryRunRow[], date: string): string[] {
  return runs
    .filter((run) => jstDateString(run.started_at) === date)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map((run) => run.id);
}

export function summarizeGalleryDates(
  runs: GalleryRunRow[],
  pages: GalleryDatePageRow[],
): GalleryDateSummary[] {
  const runStartedAt = new Map(runs.map((run) => [run.id, run.started_at]));
  const dateMap = new Map<string, Record<string, number>>();

  for (const page of pages) {
    const startedAt = runStartedAt.get(page.run_id);
    if (!startedAt) continue;

    const date = jstDateString(startedAt);
    const counts = dateMap.get(date) ?? {};
    counts[page.franchise] = (counts[page.franchise] || 0) + 1;
    dateMap.set(date, counts);
  }

  return Array.from(dateMap.entries())
    .map(([date, franchises]) => ({ date, franchises }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
