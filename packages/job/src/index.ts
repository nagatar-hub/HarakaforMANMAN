import { createSupabaseClientFromSecrets } from './lib/supabase.js';
import { runSync } from './jobs/sync.js';
import { runGenerate } from './jobs/generate.js';
import { runRegeneratePage } from './jobs/regenerate-page.js';
import { runWatchdog } from './jobs/watchdog.js';
import { sendDiscordNotification, COLOR } from './lib/discord.js';

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
      case 'watchdog':
        await runWatchdog();
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
    try {
      await sendDiscordNotification({
        title: `🔴 ジョブ異常終了: ${jobName}`,
        description: error instanceof Error ? error.message : String(error),
        color: COLOR.ERROR,
        fields: [
          { name: 'ジョブ', value: jobName, inline: true },
          { name: 'トリガー', value: process.env.TRIGGER || 'unknown', inline: true },
        ],
      });
    } catch {
      // Discord 通知失敗は無視
    }
    process.exit(1);
  }
}

async function runHealthcheck() {
  const supabase = await createSupabaseClientFromSecrets();
  const { data, error } = await supabase.from('run').select('id').limit(1);
  if (error) throw new Error(`Supabase: ${error.message}`);
  console.log('Supabase: OK');
}

main();
