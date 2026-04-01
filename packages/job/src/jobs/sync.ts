/**
 * Sync ジョブ — データ取込からページプランニングまでの統合パイプライン
 *
 * 処理フロー:
 * 1.  Run レコード作成
 * 2.  OAuth credentials 取得
 * 3.  KECAK スプレッドシートから 3 シート取得 → raw_import 保存
 * 4.  Haraka DB スプレッドシートの DB タブから一括取得 → franchise 別 LookupMap 構築
 * 5.  PreparedCard 変換 → prepared_card 保存
 * 6.  Spectre 取込 → prepared_card 追加 (source='spectre')
 * 7.  重複排除 (KECAK > SPECTRE > manual)
 * 8.  画像ヘルスチェック → image_status 更新
 * 9.  タグなしカード集計
 * 10. ページプランニング → generated_page 保存
 */

import { createSupabaseClient } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { batchInsert, batchUpsert } from '../lib/batch.js';
import { parseKecakRows } from '../lib/kecak-parser.js';
import { buildLookupMap } from '../lib/db-lookup.js';
import { buildDbCardRows } from '../lib/db-card-sync.js';
import { prepareCards } from '../lib/prepare-cards.js';
import { parseSpectreRows } from '../lib/spectre-parser.js';
import { deduplicateByListNo } from '../lib/dedup.js';
import { checkImageHealth } from '../lib/image-health-check.js';
import { updateProgress, clearProgress } from '../lib/progress.js';
import { planPages } from '../lib/page-planner.js';
import type {
  Database,
  Franchise,
  PreparedCardRow,
  AssetProfileRow,
  RuleRow,
} from '@haraka/shared';
import { FRANCHISES, KECAK_SHEET_MAP, DB_COLS } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type GeneratedPageInsert = Database['public']['Tables']['generated_page']['Insert'];

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

export async function runSync() {
  const supabase = createSupabaseClient();

  // ---- 1. Run レコード作成 ----
  const { data: run, error: runError } = await supabase
    .from('run')
    .insert({ triggered_by: process.env.TRIGGER || 'manual' })
    .select()
    .single<RunRow>();
  if (runError || !run) throw new Error(`Run作成失敗: ${runError?.message}`);
  console.log(`[sync] Run 作成: ${run.id}`);

  try {
    // ---- 2. OAuth access token 取得 ----
    await updateProgress(supabase, run.id, 0, 100, '認証中...');
    const accessToken = await getAccessToken();
    console.log('[sync] Access token 取得完了');

    const kecakSpreadsheetId = process.env.KECAK_SPREADSHEET_ID;
    const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
    if (!kecakSpreadsheetId) throw new Error('KECAK_SPREADSHEET_ID が未設定です');
    if (!harakaDbSpreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID が未設定です');

    // ---- 3. KECAK 取得 + raw_import 保存 ----
    await updateProgress(supabase, run.id, 5, 100, 'KECAK インポート中...');
    let totalImported = 0;
    const allRawImports: RawImportRow[] = [];

    for (let fi = 0; fi < FRANCHISES.length; fi++) {
      const franchise = FRANCHISES[fi];
      const sheetName = KECAK_SHEET_MAP[franchise];
      console.log(`[sync] KECAK取得: ${sheetName} (${franchise})`);
      await updateProgress(supabase, run.id, 5 + fi * 5, 100, `KECAK: ${franchise}...`);

      const rows = await fetchSheetValues({
        accessToken,
        spreadsheetId: kecakSpreadsheetId,
        range: `${sheetName}`,
      });

      const parsed = parseKecakRows(rows, franchise, run.id);
      if (parsed.length === 0) {
        console.log(`[sync]   → 0件（スキップ）`);
        continue;
      }

      await batchInsert(supabase, 'raw_import', parsed as unknown as Record<string, unknown>[]);

      const { data: inserted, error: fetchError } = await supabase
        .from('raw_import')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<RawImportRow[]>();
      if (fetchError) throw new Error(`raw_import 取得失敗: ${fetchError.message}`);

      allRawImports.push(...(inserted ?? []));
      totalImported += parsed.length;
      console.log(`[sync]   → ${parsed.length}件 インポート完了`);
    }

    await supabase.from('run').update({
      total_imported: totalImported,
      import_done_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.log(`[sync] インポート完了: 合計 ${totalImported}件`);

    // ---- 4. Haraka DB 照合用マップ構築（DBタブから一括取得） ----
    await updateProgress(supabase, run.id, 20, 100, 'Haraka DB 照合中...');
    const lookupMaps = new Map<Franchise, ReturnType<typeof buildLookupMap>>();

    console.log('[sync] Haraka DB 取得: DBタブ');
    const allDbRows = await fetchSheetValues({
      accessToken,
      spreadsheetId: harakaDbSpreadsheetId,
      range: 'DB',
    });

    const dbHeader = allDbRows[0] ?? [];
    const dbDataRows = allDbRows.slice(1);

    for (const franchise of FRANCHISES) {
      const franchiseRows = dbDataRows.filter(
        (row) => row[DB_COLS.FRANCHISE - 1] === franchise
      );
      const lookupMap = buildLookupMap([dbHeader, ...franchiseRows]);
      lookupMaps.set(franchise, lookupMap);
      console.log(`[sync]   → ${franchise}: ${franchiseRows.length}件 LookupMap 構築完了`);
    }

    // ---- 4.5. db_card テーブルへ upsert ----
    const dbCardRows = buildDbCardRows(dbDataRows);
    if (dbCardRows.length > 0) {
      await batchUpsert(
        supabase,
        'db_card',
        dbCardRows as unknown as Record<string, unknown>[],
        'franchise,card_name,grade,list_no',
      );
      console.log(`[sync] db_card upsert 完了: ${dbCardRows.length}件`);
    }

    // ---- 5. PreparedCard 変換 + 保存 ----
    await updateProgress(supabase, run.id, 30, 100, 'PreparedCard 変換中...');
    let totalPrepared = 0;

    for (const franchise of FRANCHISES) {
      const rawImports = allRawImports.filter(r => r.franchise === franchise);
      if (rawImports.length === 0) continue;

      const lookupMap = lookupMaps.get(franchise);
      if (!lookupMap) continue;

      const prepared = prepareCards(rawImports, lookupMap, franchise);
      if (prepared.length === 0) continue;

      await batchInsert(supabase, 'prepared_card', prepared as unknown as Record<string, unknown>[]);
      totalPrepared += prepared.length;
      console.log(`[sync] PreparedCard: ${franchise} → ${prepared.length}件`);
    }

    await supabase.from('run').update({
      total_prepared: totalPrepared,
      prepare_done_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.log(`[sync] 準備完了: ${totalPrepared}件`);

    // ---- 6. Spectre 取込 ----
    await updateProgress(supabase, run.id, 40, 100, 'Spectre 取込中...');
    console.log('[sync] SpectreMapping 取得中...');
    try {
      const spectreRows = await fetchSheetValues({
        accessToken,
        spreadsheetId: harakaDbSpreadsheetId,
        range: 'SpectreMapping',
      });

      if (spectreRows.length > 1) {
        const spectreCards = parseSpectreRows(spectreRows, 'Pokemon', run.id);
        if (spectreCards.length > 0) {
          await batchInsert(supabase, 'prepared_card', spectreCards as unknown as Record<string, unknown>[]);
          totalPrepared += spectreCards.length;
          console.log(`[sync] Spectre カード: ${spectreCards.length}件 追加`);
        }
      }
    } catch (spectreErr) {
      console.log(`[sync] SpectreMapping スキップ: ${spectreErr instanceof Error ? spectreErr.message : String(spectreErr)}`);
    }

    await supabase.from('run').update({
      spectre_done_at: new Date().toISOString(),
      total_prepared: totalPrepared,
    }).eq('id', run.id);

    // ---- 7. 重複排除 ----
    await updateProgress(supabase, run.id, 45, 100, '重複排除中...');
    console.log('[sync] 重複排除...');

    for (const franchise of FRANCHISES) {
      const { data: cards, error: cardsError } = await supabase
        .from('prepared_card')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<PreparedCardRow[]>();
      if (cardsError) throw new Error(`prepared_card 取得失敗: ${cardsError.message}`);
      if (!cards || cards.length === 0) continue;

      const deduped = deduplicateByListNo(cards);
      const removedCount = cards.length - deduped.length;

      if (removedCount > 0) {
        const keepIds = new Set(deduped.map(c => c.id));
        const removeIds = cards.filter(c => !keepIds.has(c.id)).map(c => c.id);

        // バッチで削除（Supabase の in() 制限対策）
        for (let i = 0; i < removeIds.length; i += 100) {
          const batch = removeIds.slice(i, i + 100);
          await supabase.from('prepared_card').delete().in('id', batch);
        }
        console.log(`[sync]   ${franchise}: ${removedCount}件 重複除外`);
      }
    }

    // ---- 8. 画像ヘルスチェック ----
    await updateProgress(supabase, run.id, 50, 100, '画像ヘルスチェック中...');
    console.log('[sync] 画像ヘルスチェック...');

    const { data: allPrepared, error: prepError } = await supabase
      .from('prepared_card')
      .select('*')
      .eq('run_id', run.id)
      .returns<PreparedCardRow[]>();
    if (prepError) throw new Error(`prepared_card 取得失敗: ${prepError.message}`);

    const deadCount = await checkImageHealth(supabase, run.id, allPrepared ?? []);

    await supabase.from('run').update({
      total_image_ng: deadCount,
      health_check_done_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.log(`[sync] 画像チェック完了: dead=${deadCount}`);

    // ---- 9. タグなしカード集計 ----
    const { count: untaggedCount } = await supabase
      .from('prepared_card')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .is('tag', null);

    const totalUntagged = untaggedCount ?? 0;

    // ---- 9b. 価格未記入カード集計 ----
    const { count: priceMissingCount } = await supabase
      .from('prepared_card')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .or('price_high.is.null,price_low.is.null,price_high.eq.0,price_low.eq.0');

    const totalPriceMissing = priceMissingCount ?? 0;

    await supabase.from('run').update({
      total_untagged: totalUntagged,
      total_price_missing: totalPriceMissing,
    }).eq('id', run.id);

    if (totalUntagged > 0) {
      console.warn(`[sync] ⚠️ タグなしカード: ${totalUntagged}件`);
    }
    if (totalPriceMissing > 0) {
      console.warn(`[sync] ⚠️ 価格未記入カード: ${totalPriceMissing}件`);
    }

    // ---- 10. ページプランニング ----
    await updateProgress(supabase, run.id, 80, 100, 'ページプランニング中...');
    console.log('[sync] ページプランニング...');

    // dedup 後の最新 prepared_card を再取得
    const { data: finalCards, error: finalError } = await supabase
      .from('prepared_card')
      .select('*')
      .eq('run_id', run.id)
      .returns<PreparedCardRow[]>();
    if (finalError) throw new Error(`prepared_card 取得失敗: ${finalError.message}`);

    let totalPages = 0;

    for (const franchise of FRANCHISES) {
      const franchiseCards = (finalCards ?? []).filter(c => c.franchise === franchise);
      if (franchiseCards.length === 0) continue;

      // タグなし・価格未記入カードを除外
      const validCards = franchiseCards.filter(c => c.tag && c.price_high != null && c.price_high > 0 && c.price_low != null && c.price_low > 0);
      const untaggedCards = franchiseCards.filter(c => !c.tag);
      const priceMissingCards = franchiseCards.filter(c => c.tag && (!c.price_high || !c.price_low));

      if (untaggedCards.length > 0) {
        console.warn(`[sync]   ${franchise}: タグ未設定 ${untaggedCards.length}件（除外）`);
        for (const c of untaggedCards.slice(0, 10)) {
          console.warn(`[sync]     - ${c.card_name} (${c.grade ?? ''} ${c.list_no ?? ''}) ¥${(c.price_high ?? 0).toLocaleString()}`);
        }
        if (untaggedCards.length > 10) {
          console.warn(`[sync]     ... 他 ${untaggedCards.length - 10}件`);
        }
      }

      if (priceMissingCards.length > 0) {
        console.warn(`[sync]   ${franchise}: 価格未記入 ${priceMissingCards.length}件（除外）`);
        for (const c of priceMissingCards.slice(0, 10)) {
          console.warn(`[sync]     - ${c.card_name} (${c.grade ?? ''} ${c.list_no ?? ''}) tag=${c.tag}`);
        }
        if (priceMissingCards.length > 10) {
          console.warn(`[sync]     ... 他 ${priceMissingCards.length - 10}件`);
        }
      }

      if (validCards.length === 0) continue;

      // asset_profile 取得
      const { data: profile, error: profileError } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('franchise', franchise)
        .single<AssetProfileRow>();
      if (profileError || !profile) throw new Error(`asset_profile 取得失敗 (${franchise}): ${profileError?.message}`);

      // rule 取得
      const { data: rules, error: rulesError } = await supabase
        .from('rule')
        .select('*')
        .eq('franchise', franchise)
        .returns<RuleRow[]>();
      if (rulesError) throw new Error(`rule 取得失敗: ${rulesError.message}`);

      // プランニング
      const pagePlans = planPages(validCards, rules ?? [], profile.total_slots);
      console.log(`[sync]   ${franchise}: ${pagePlans.length}ページ`);

      // タグ構成ログ
      const cardById = new Map(validCards.map(c => [c.id, c]));
      for (const plan of pagePlans) {
        const tagCounts = new Map<string, number>();
        for (const id of plan.cardIds) {
          const tag = cardById.get(id)?.tag || '?';
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
        const tagSummary = [...tagCounts.entries()]
          .map(([t, n]) => `${t}(${n})`)
          .join(', ');
        console.log(`[sync]     ${plan.label} [${plan.cardIds.length}枚]: ${tagSummary}`);
      }

      if (pagePlans.length === 0) continue;

      // generated_page レコードを insert
      const pageInserts: GeneratedPageInsert[] = pagePlans.map((plan, index) => ({
        run_id: run.id,
        franchise,
        page_index: index,
        page_label: plan.label,
        card_ids: plan.cardIds,
        status: 'pending' as const,
      }));
      await batchInsert(supabase, 'generated_page', pageInserts as unknown as Record<string, unknown>[]);

      totalPages += pagePlans.length;
      await updateProgress(supabase, run.id, 80 + Math.round((FRANCHISES.indexOf(franchise) + 1) / FRANCHISES.length * 15), 100, `${franchise}: ${pagePlans.length}ページ 計画完了`);
    }

    // ---- 完了 ----
    await supabase.from('run').update({
      total_prepared: totalPrepared,
      total_pages: totalPages,
      plan_done_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);

    await clearProgress(supabase, run.id);
    console.log(`[sync] 完了: imported=${totalImported}, prepared=${totalPrepared}, untagged=${totalUntagged}, image_ng=${deadCount}, pages=${totalPages}`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('run').update({
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    await clearProgress(supabase, run.id);
    throw err;
  }
}
