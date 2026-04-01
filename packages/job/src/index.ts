import { createSupabaseClient } from './lib/supabase.js';
import { runSync } from './jobs/sync.js';
import { runGenerate } from './jobs/generate.js';
import { runRegeneratePage } from './jobs/regenerate-page.js';

async function main() {
  const jobName = process.env.JOB_NAME || 'healthcheck';
  console.log(`[Haraka Job] Starting: ${jobName}`);

  try {
    switch (jobName) {
      case 'sync':
        await runSync();
        break;
      case 'generate':
        await runGenerate();
        break;
      case 'regenerate-page':
        await runRegeneratePage();
        break;
      case 'healthcheck':
        await runHealthcheck();
        break;
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
    console.log(`[Haraka Job] ${jobName} completed successfully`);
    process.exit(0);
  } catch (error) {
    console.error(`[Haraka Job] ${jobName} failed:`, error);
    process.exit(1);
  }
}

async function runHealthcheck() {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('run').select('id').limit(1);
  if (error) throw new Error(`Supabase: ${error.message}`);
  console.log('Supabase: OK');
}

main();
