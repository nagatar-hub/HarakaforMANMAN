import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { updateDbSheetCell } from '../lib/haraka-db-sheet.js';
import { fork } from 'child_process';
import path from 'path';

export const runRoutes = new Hono();

/** 実行中ジョブのPID管理（インスタンス内メモリ） */
const runningJobs: { jobName: string; pid: number; startedAt: Date }[] = [];

/** 実行履歴一覧 */
runRoutes.get('/runs', async (c) => {
  const supabase = createSupabaseClient();
  const limit = parseInt(c.req.query('limit') || '20');
  const { data, error } = await supabase
    .from('run')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

/** 特定ランの詳細 */
runRoutes.get('/runs/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('run').select('*').eq('id', id).single();
  if (error) return c.json({ error: error.message }, 500);

  // ページ数も取得
  const { count } = await supabase
    .from('generated_page')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', id)
    .eq('status', 'generated');

  return c.json({ ...data, generated_page_count: count });
});

/** ジョブトリガー (sync / generate) */
function triggerJob(jobName: string) {
  // packages/api/dist/routes/ → packages/job/dist/index.js
  const jobEntry = path.resolve(__dirname, '..', '..', '..', 'job', 'dist', 'index.js');
  const child = fork(jobEntry, [], {
    env: { ...process.env, JOB_NAME: jobName, TRIGGER: 'web-ui' },
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
  const pid = child.pid;
  if (pid) {
    runningJobs.push({ jobName, pid, startedAt: new Date() });
    child.on('exit', () => {
      const idx = runningJobs.findIndex(j => j.pid === pid);
      if (idx !== -1) runningJobs.splice(idx, 1);
    });
  }
  return pid;
}

runRoutes.post('/jobs/sync', async (c) => {
  try {
    const pid = triggerJob('sync');
    return c.json({ status: 'triggered', job: 'sync', pid });
  } catch (err) {
    return c.json({ error: `Failed to trigger: ${(err as Error).message}` }, 500);
  }
});

runRoutes.post('/jobs/generate', async (c) => {
  try {
    const pid = triggerJob('generate');
    return c.json({ status: 'triggered', job: 'generate', pid });
  } catch (err) {
    return c.json({ error: `Failed to trigger: ${(err as Error).message}` }, 500);
  }
});

/** 指定 run のタグなしカード一覧 */
runRoutes.get('/runs/:id/untagged-cards', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, price_high, source')
    .eq('run_id', id)
    .is('tag', null)
    .order('franchise')
    .order('price_high', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

/** 指定 run の画像NGカード一覧 */
runRoutes.get('/runs/:id/image-issues', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, image_status')
    .eq('run_id', id)
    .eq('image_status', 'dead')
    .order('franchise')
    .order('card_name');
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

/** 指定 run の価格未記入カード一覧 */
runRoutes.get('/runs/:id/price-missing', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, tag, price_high, price_low, source')
    .eq('run_id', id)
    .or('price_high.is.null,price_low.is.null')
    .order('franchise')
    .order('price_high', { ascending: false, nullsFirst: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

/** 生成前確認: 除外カード一覧（タグなし + 価格未記入 + 画像NG） */
runRoutes.get('/runs/:id/excluded-cards', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();

  // タグなし
  const { data: untagged } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, tag, price_high, price_low')
    .eq('run_id', id)
    .is('tag', null)
    .order('franchise')
    .order('price_high', { ascending: false });

  // 価格未記入（タグありのみ — タグなしは上で拾っている）
  const { data: priceMissing } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, tag, price_high, price_low')
    .eq('run_id', id)
    .not('tag', 'is', null)
    .or('price_high.is.null,price_low.is.null')
    .order('franchise')
    .order('card_name');

  // 画像NG
  const { data: imageNg } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, tag, price_high, price_low, image_status')
    .eq('run_id', id)
    .eq('image_status', 'dead')
    .order('franchise')
    .order('card_name');

  return c.json({
    untagged: untagged ?? [],
    price_missing: priceMissing ?? [],
    image_ng: imageNg ?? [],
  });
});

/** 強制停止: 子プロセスをkill + DBステータス更新 */
runRoutes.post('/runs/:id/reset', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: run } = await supabase.from('run').select('status').eq('id', id).single();
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Run is ${run.status}, not running` }, 400);

  // 実行中のジョブプロセスをkill
  let killed = 0;
  for (let i = runningJobs.length - 1; i >= 0; i--) {
    const job = runningJobs[i];
    try {
      process.kill(job.pid, 'SIGTERM');
      killed++;
      console.log(`[reset] プロセス ${job.pid} (${job.jobName}) にSIGTERM送信`);
    } catch {
      // プロセスが既に終了している場合
      console.log(`[reset] プロセス ${job.pid} は既に終了`);
    }
    runningJobs.splice(i, 1);
  }

  const { error } = await supabase.from('run').update({
    status: 'failed',
    error_message: `手動で強制停止されました (${killed}プロセス停止)`,
    completed_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ status: 'reset', id, killed });
});

/** KECAKデータCSVエクスポート */
runRoutes.get('/runs/:id/kecak-csv', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();

  const { data, error } = await supabase
    .from('raw_import')
    .select('franchise, card_name, grade, list_no, rarity, kecak_price, demand, image_url')
    .eq('run_id', id)
    .order('franchise')
    .order('kecak_price', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'データがありません' }, 404);

  // BOM + CSV生成
  const headers = ['フランチャイズ', 'カード名', 'グレード', '品番', 'レアリティ', 'KECAK価格', '需要', '画像URL'];
  const rows = data.map(r => [
    r.franchise,
    r.card_name,
    r.grade || '',
    r.list_no || '',
    r.rarity || '',
    r.kecak_price != null ? String(r.kecak_price) : '',
    r.demand != null ? String(r.demand) : '',
    r.image_url || '',
  ].map(v => `"${v.replace(/"/g, '""')}"`).join(','));

  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');

  // run の日時を取得してファイル名に
  const { data: run } = await supabase.from('run').select('started_at').eq('id', id).single();
  const dateStr = run?.started_at ? new Date(run.started_at).toISOString().slice(0, 10) : 'unknown';

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="kecak_${dateStr}.csv"`,
    },
  });
});

/** 画像NG修正: 新URLをチェックし、OKならDB+シートに反映 */
runRoutes.post('/runs/:id/fix-image', async (c) => {
  const runId = c.req.param('id');
  const { prepared_card_id, new_url } = await c.req.json<{ prepared_card_id: string; new_url: string }>();

  if (!prepared_card_id || !new_url) {
    return c.json({ error: 'prepared_card_id and new_url are required' }, 400);
  }

  // 1. URL チェック (HEAD → GET フォールバック、ブラウザ UA 付き)
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
  };
  let urlOk = false;
  try {
    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), 8000);
    const r1 = await fetch(new_url, { method: 'HEAD', signal: c1.signal, redirect: 'follow', headers: browserHeaders });
    clearTimeout(t1);
    urlOk = r1.ok || (r1.status === 403 && r1.headers.get('cf-mitigated') === 'challenge');
    if (r1.status === 404 || r1.status === 410) urlOk = false;
  } catch { /* fallback to GET */ }
  if (!urlOk) {
    try {
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), 8000);
      const r2 = await fetch(new_url, { method: 'GET', signal: c2.signal, redirect: 'follow', headers: { ...browserHeaders, Range: 'bytes=0-0' } });
      clearTimeout(t2);
      urlOk = r2.ok || r2.status === 206 || (r2.status === 403 && r2.headers.get('cf-mitigated') === 'challenge');
    } catch { urlOk = false; }
  }

  if (!urlOk) {
    return c.json({ success: false, status: 'dead', message: 'URL is not accessible' });
  }

  const supabase = createSupabaseClient();

  // 2. prepared_card を更新
  const { data: card, error: cardErr } = await supabase
    .from('prepared_card')
    .update({ alt_image_url: new_url, image_status: 'fallback' as const })
    .eq('id', prepared_card_id)
    .select('franchise, card_name, grade, list_no')
    .single();

  if (cardErr || !card) {
    return c.json({ error: cardErr?.message || 'Card not found' }, 500);
  }

  // 3. run の total_image_ng をデクリメント
  const { data: run } = await supabase.from('run').select('total_image_ng').eq('id', runId).single();
  if (run && run.total_image_ng > 0) {
    await supabase.from('run').update({ total_image_ng: run.total_image_ng - 1 }).eq('id', runId);
  }

  // 4. db_card を検索して alt_image_url を更新 + シート書き戻し
  let query = supabase
    .from('db_card')
    .select('id, sheet_row_number')
    .eq('franchise', card.franchise)
    .eq('card_name', card.card_name);

  if (card.grade) query = query.eq('grade', card.grade);
  if (card.list_no) query = query.eq('list_no', card.list_no);

  const { data: dbCards } = await query.limit(1);

  if (dbCards && dbCards.length > 0) {
    const dbCard = dbCards[0];
    await supabase.from('db_card').update({ alt_image_url: new_url, image_status: 'fallback' }).eq('id', dbCard.id);

    // シート書き戻し（非同期、エラーは無視）
    if (dbCard.sheet_row_number) {
      updateDbSheetCell(dbCard.sheet_row_number, 'alt_image_url', new_url).catch((err) => {
        console.error(`[sheet] セル更新エラー: ${(err as Error).message}`);
      });
    }
  }

  return c.json({ success: true, status: 'fallback' });
});
