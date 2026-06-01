/**
 * MANMAN テンプレート画像を Supabase Storage にアップロードし、
 * layout_template(kind='store') を upsert する CLI。
 *
 * Usage:
 *   npx tsx packages/job/src/scripts/upload-manman-store-templates.ts \
 *     --src "H:/マイドライブ/買取表PSD/満満/画像" \
 *     [--dry-run] [--debug-out "./out/manman-layouts"]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { detectLayoutFromBuffer, renderDetectionDebugImage } from '../lib/layout-detector.js';
import { FRANCHISES } from '@haraka/shared';
import type { Franchise, LayoutConfig, LayoutTemplateRow } from '@haraka/shared';

const SUPPORTED_SLOTS = [1, 2, 4, 6, 8, 9, 15, 20, 40];
const STORE_NAME = process.env.STORE_NAME ?? 'manman';

const FRANCHISE_FILE_LABEL: Record<Franchise, string> = {
  Pokemon: 'ポケカ',
  'ONE PIECE': 'ONEPIECE',
  'YU-GI-OH!': '遊戯王',
};

const FRANCHISE_SLUG: Record<Franchise, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function fileNameFor(franchise: Franchise, slots: number): string {
  return `トレカ満満買取表テンプレ - ${FRANCHISE_FILE_LABEL[franchise]}${slots}.png`;
}

function storagePathFor(franchise: Franchise, slots: number): string {
  return `templates/${STORE_NAME}/store/${FRANCHISE_SLUG[franchise]}/${slots}.png`;
}

function cardBackPathFor(franchise: Franchise): string {
  return `card-backs/${STORE_NAME}/${FRANCHISE_SLUG[franchise]}.png`;
}

function scaleRarityIcon(layout: LayoutConfig): LayoutConfig {
  const iconSize = Math.max(20, Math.round(layout.cardWidth * 0.45));
  return {
    ...layout,
    rarityIconWidth: iconSize,
    rarityIconHeight: iconSize,
    rarityIconOffsetY: Math.round(layout.cardHeight * (-10 / 170)),
    layoutAdjust: { cardYDelta: -4, priceYDelta: -5 },
  };
}

async function main() {
  const src = argValue('--src', 'H:/マイドライブ/買取表PSD/満満/画像');
  const debugOut = argValue('--debug-out', '');
  const dryRun = process.argv.includes('--dry-run');
  const supabase = dryRun ? null : await createSupabaseClientFromSecrets();

  if (debugOut) await fs.mkdir(debugOut, { recursive: true });
  console.log(`[upload-manman-store-templates] src=${src} store=${STORE_NAME} dryRun=${dryRun}`);

  for (const franchise of FRANCHISES) {
    console.log(`[franchise] ${franchise}`);

    for (const slots of SUPPORTED_SLOTS) {
      const fileName = fileNameFor(franchise, slots);
      const filePath = path.join(src, fileName);
      let buffer: Buffer;

      try {
        buffer = await fs.readFile(filePath);
      } catch (err) {
        console.warn(`  [skip] ${slots}: ${fileName} (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }

      const detected = await detectLayoutFromBuffer(buffer);
      if (detected.totalSlots !== slots) {
        console.warn(`  [warn] ${fileName}: expected ${slots}, detected ${detected.totalSlots}`);
      }

      if (debugOut) {
        const debug = await renderDetectionDebugImage(buffer, detected);
        await fs.writeFile(path.join(debugOut, `debug-${FRANCHISE_SLUG[franchise]}-${slots}.png`), debug);
      }

      const templateStoragePath = storagePathFor(franchise, slots);
      const detectedName = detected.totalSlots === slots
        ? `${slots}枠 店頭用`
        : `${detected.totalSlots}枠 店頭用 (原稿${slots})`;
      const row: Omit<LayoutTemplateRow, 'id' | 'created_at' | 'updated_at'> = {
        store: STORE_NAME,
        franchise,
        kind: 'store',
        name: detectedName,
        slug: `store_${slots}`,
        grid_cols: detected.gridCols,
        grid_rows: detected.gridRows,
        total_slots: detected.totalSlots,
        img_width: detected.imgWidth,
        img_height: detected.imgHeight,
        template_storage_path: templateStoragePath,
        card_back_storage_path: cardBackPathFor(franchise),
        layout_config: scaleRarityIcon(detected.layoutConfig),
        skip_price_low: true,
        is_default: slots === 40,
        is_active: true,
        priority: slots === 40 ? 10 : 0,
      };

      if (dryRun) {
        console.log(`  [dry-run] ${fileName} -> ${templateStoragePath} (${buffer.byteLength} bytes, ${detected.gridCols}x${detected.gridRows})`);
        continue;
      }

      if (!supabase) throw new Error('Supabase client is not initialized');

      const { error: uploadErr } = await supabase.storage
        .from('haraka-images')
        .upload(templateStoragePath, buffer, { contentType: 'image/png', upsert: true });
      if (uploadErr) throw new Error(`Storage upload failed ${templateStoragePath}: ${uploadErr.message}`);

      const { error: upsertErr } = await supabase
        .from('layout_template')
        .upsert(row, { onConflict: 'store,franchise,kind,slug' });
      if (upsertErr) throw new Error(`layout_template upsert failed ${franchise}/${slots}: ${upsertErr.message}`);

      console.log(`  [ok] ${slots}: ${templateStoragePath} (${detected.gridCols}x${detected.gridRows})`);
    }
  }

  console.log('[upload-manman-store-templates] 完了');
}

main().catch((err) => {
  console.error('[upload-manman-store-templates] failed:', err);
  process.exit(1);
});
