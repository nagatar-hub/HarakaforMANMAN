// Read-only live verification. Supply existing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
import { runTokyoBuybackSync } from '../jobs/tokyo-buyback-sync.js';

process.env.STORE_NAME = 'manman-akihabara';
runTokyoBuybackSync({ dryRun: true }).then(({ snapshot, products }) => {
  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    checker_run_id: snapshot.checker_run_id,
    order_list_import_id: snapshot.order_list_import_id,
    product_types: products.reduce<Record<string, number>>((counts, row) => {
      counts[row.product_type] = (counts[row.product_type] ?? 0) + 1;
      return counts;
    }, {}),
    unmatched_reasons: snapshot.report.unmatched.reduce<Record<string, number>>((counts, row) => {
      const key = `${row.candidate.source}:${row.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    samples: products.slice(0, 5),
    unmatched_samples: snapshot.report.unmatched.slice(0, 20),
  }, null, 2));
}).catch(error => {
  console.error(error instanceof Error ? error.message : 'Tracking verification failed');
  process.exitCode = 1;
});
