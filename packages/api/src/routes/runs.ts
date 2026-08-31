import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { updateDbSheetCell } from '../lib/haraka-db-sheet.js';
import { executeCloudRunJob } from '../lib/cloud-run-jobs.js';
import { isDefinitiveCloudRunJobRejection } from '../lib/cloud-run-errors.js';
import {
  claimGenerateRun,
  createSupabaseGenerateRunClaimStore,
  GenerateRunClaimError,
  parseGenerateRunRequest,
} from '../lib/generate-run-claim.js';
import { authorizeInternalApiRequest } from '../lib/internal-api-auth.js';

export const runRoutes = new Hono();

const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
const GENERATE_JOB_NAME = process.env.GENERATE_JOB_NAME?.trim() || `haraka-${STORE_NAME}-generate`;

export function redactGenerateClaimToken(run: Record<string, unknown>): Record<string, unknown> {
  const publicRun = { ...run };
  delete publicRun.generate_claim_token;
  return publicRun;
}

async function findRunInStore(
  supabase: ReturnType<typeof createSupabaseClient>,
  runId: string,
) {
  return supabase
    .from('run')
    .select('id')
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .maybeSingle();
}

/** 実行履歴一覧 */
runRoutes.get('/runs', async (c) => {
  const supabase = createSupabaseClient();
  const limit = parseInt(c.req.query('limit') || '20');
  const { data, error } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json((data ?? []).map((run) => redactGenerateClaimToken(run)));
});

/** 特定ランの詳細 */
runRoutes.get('/runs/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('run')
    .select('*')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Run not found' }, 404);

  // ページ数も取得
  const { count } = await supabase
    .from('generated_page')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', id)
    .eq('status', 'generated');

  return c.json({ ...redactGenerateClaimToken(data), generated_page_count: count });
});

runRoutes.post('/jobs/sync', (c) => c.json({
  error: '直接同期は廃止されました。保護されたオーダーリスト読み込み画面から確認・反映してください。',
}, 410));

runRoutes.post('/jobs/generate', async (c) => {
  const auth = authorizeInternalApiRequest(c.req.header('authorization'));
  if (auth === 'misconfigured') {
    return c.json({ error: '画像生成APIの認証設定がありません' }, 503);
  }
  if (auth !== 'authorized') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let payload: unknown = {};
  if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    try {
      payload = await c.req.json<unknown>();
    } catch {
      return c.json({ error: '画像生成リクエストのJSONが正しくありません' }, 400);
    }
  }
  const parsed = parseGenerateRunRequest(payload);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const supabase = createSupabaseClient();
  const claimStore = createSupabaseGenerateRunClaimStore(supabase, STORE_NAME);
  let claim: Awaited<ReturnType<typeof claimGenerateRun>>;
  try {
    claim = await claimGenerateRun(claimStore, parsed.runId);
  } catch (error) {
    if (error instanceof GenerateRunClaimError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({
      error: '画像生成対象Runの確保に失敗しました',
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
  const runId = claim.id;

  try {
    const { operationName, executionName } = await executeCloudRunJob(GENERATE_JOB_NAME, {
      env: {
        RUN_ID: runId,
        GENERATE_CLAIM_TOKEN: claim.generate_claim_token,
        TRIGGER: 'web-ui',
        STORE_NAME,
      },
    });
    return c.json({
      status: 'triggered',
      job: 'generate',
      run_id: runId,
      operation: operationName,
      execution: executionName,
    });
  } catch (err) {
    const definitiveRejection = isDefinitiveCloudRunJobRejection(err);
    let claimReleased = false;
    let releaseError: string | null = null;
    if (definitiveRejection) {
      try {
        claimReleased = await claimStore.releaseUnstarted(
          runId,
          claim.generate_claim_token,
          claim.generate_claimed_at,
        );
      } catch (releaseFailure) {
        releaseError = releaseFailure instanceof Error
          ? releaseFailure.message
          : String(releaseFailure);
      }
    }
    return c.json({
      error: definitiveRejection
        ? claimReleased
          ? '画像生成ジョブは開始されませんでした。もう一度お試しください'
          : '画像生成の状態が変わったため、実行履歴を更新してください'
        : '画像生成ジョブの起動結果を確認できませんでした。二重起動防止のため再実行せず、実行履歴を確認してください',
      detail: err instanceof Error ? err.message : String(err),
      run_id: runId,
      launch_pending: !definitiveRejection,
      retryable: claimReleased,
      ...(releaseError ? { state_error: releaseError } : {}),
    }, 502);
  }
});
/** 指定 run のタグなしカード一覧 */
runRoutes.get('/runs/:id/untagged-cards', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, id);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

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
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, id);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

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
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, id);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

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
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, id);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

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

/** 失敗ページ一覧 */
runRoutes.get('/runs/:id/failed-pages', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, id);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

  const { data, error } = await supabase
    .from('generated_page')
    .select('id, franchise, page_index, page_label, status, error_message, created_at')
    .eq('run_id', id)
    .eq('status', 'failed')
    .order('franchise')
    .order('page_index');
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

/** 強制停止: 子プロセスをkill + DBステータス更新 */
runRoutes.post('/runs/:id/reset', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: run, error } = await supabase
    .from('run')
    .select('status')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status !== 'running') return c.json({ error: `Run is ${run.status}, not running` }, 400);
  return c.json({
    error: 'Cloud Run JobはこのAPIから安全に停止できません。実行完了を待つかCloud Run側で停止してください。',
  }, 409);
});

/** 画像NG修正: 新URLをチェックし、OKならDB+シートに反映 */
runRoutes.post('/runs/:id/fix-image', async (c) => {
  const runId = c.req.param('id');
  const { prepared_card_id, new_url } = await c.req.json<{ prepared_card_id: string; new_url: string }>();

  if (!prepared_card_id || !new_url) {
    return c.json({ error: 'prepared_card_id and new_url are required' }, 400);
  }

  const supabase = createSupabaseClient();
  const { data: scopedRun, error: scopedRunError } = await findRunInStore(supabase, runId);
  if (scopedRunError) return c.json({ error: scopedRunError.message }, 500);
  if (!scopedRun) return c.json({ error: 'Run not found' }, 404);

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

  // 2. prepared_card を更新
  const { data: card, error: cardErr } = await supabase
    .from('prepared_card')
    .update({ alt_image_url: new_url, image_status: 'fallback' as const })
    .eq('id', prepared_card_id)
    .eq('run_id', runId)
    .select('franchise, card_name, grade, list_no')
    .single();

  if (cardErr || !card) {
    return c.json({ error: cardErr?.message || 'Card not found' }, 500);
  }

  // 3. run の total_image_ng をデクリメント
  const { data: run } = await supabase
    .from('run')
    .select('total_image_ng')
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .single();
  if (run && run.total_image_ng > 0) {
    await supabase
      .from('run')
      .update({ total_image_ng: run.total_image_ng - 1 })
      .eq('id', runId)
      .eq('store', STORE_NAME);
  }

  // 4. db_card を検索して alt_image_url を更新 + シート書き戻し
  let query = supabase
    .from('db_card')
    .select('id, sheet_row_number')
    .eq('store', STORE_NAME)
    .eq('franchise', card.franchise)
    .eq('card_name', card.card_name);

  if (card.grade) query = query.eq('grade', card.grade);
  if (card.list_no) query = query.eq('list_no', card.list_no);

  const { data: dbCards } = await query.limit(1);

  if (dbCards && dbCards.length > 0) {
    const dbCard = dbCards[0];
    await supabase.from('db_card').update({ alt_image_url: new_url, image_status: 'fallback' }).eq('id', dbCard.id).eq('store', STORE_NAME);

    // シート書き戻し（非同期、エラーは無視）
    if (dbCard.sheet_row_number) {
      updateDbSheetCell(dbCard.sheet_row_number, 'alt_image_url', new_url).catch((err) => {
        console.error(`[sheet] セル更新エラー: ${(err as Error).message}`);
      });
    }
  }

  return c.json({ success: true, status: 'fallback' });
});
