import 'server-only';

import type { RunRow } from '@haraka/shared';

import { STORE_NAME } from '@/lib/store';
import { createServerSupabase } from '@/lib/supabase-server';

export type DashboardPageSummary = {
  id: string;
  franchise: string;
  page_label: string | null;
  image_url: string | null;
};

export async function loadDashboardData(
  supabase: ReturnType<typeof createServerSupabase> = createServerSupabase(),
) {
  const { data: rawRun } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const run = rawRun as RunRow | null;
  if (!run) {
    return {
      run: null,
      untaggedCount: 0,
      recentPages: [] as DashboardPageSummary[],
    };
  }

  // The parent run is store-scoped above. Derived rows are only queried with
  // that verified run ID, so a run belonging to another store cannot leak in.
  const [{ count }, { data: pages }] = await Promise.all([
    supabase
      .from('prepared_card')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .is('tag', null),
    supabase
      .from('generated_page')
      .select('id, franchise, page_label, image_url')
      .eq('run_id', run.id)
      .eq('status', 'generated')
      .order('franchise')
      .order('page_index')
      .limit(6),
  ]);

  return {
    run,
    untaggedCount: count ?? 0,
    recentPages: (pages ?? []) as DashboardPageSummary[],
  };
}
