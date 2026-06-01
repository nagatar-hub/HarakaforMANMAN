import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { downloadFromStorage, uploadToStorage } from '../lib/asset-storage.js';
import { FRANCHISES } from '@haraka/shared';
import type { Franchise } from '@haraka/shared';

const BUCKET = 'haraka-images';

const FRANCHISE_SLUG: Record<Franchise, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

const ORIPARK_STORE_DIR = 'H:/マイドライブ/買取表PSD/PSD/Haraka用/店頭用/画像';
const MANMAN_STORE_DIR = 'H:/マイドライブ/買取表PSD/満満/画像';
const ORIPARK_STORE_SLOTS = [1, 2, 4, 6, 9, 15, 20, 40] as const;
const MANMAN_STORE_SLOTS = [1, 2, 4, 6, 8, 9, 15, 20, 40] as const;

type Supabase = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;

function oriparkStoreFileName(franchise: Franchise, slots: number): string {
  const suffix = franchise === 'Pokemon' ? '' : franchise === 'ONE PIECE' ? 'ONEPIECE' : '遊戯王';
  const slotsLabel = slots === 40 ? '40' : `${slots}枚`;
  return `買取表ひな形${slotsLabel}店頭用${suffix}.png`;
}

function manmanStoreFileName(franchise: Franchise, slots: number): string {
  const label = franchise === 'Pokemon' ? 'ポケカ' : franchise === 'ONE PIECE' ? 'ONEPIECE' : '遊戯王';
  return `トレカ満満買取表テンプレ - ${label}${slots}.png`;
}

async function copyStorageObject(supabase: Supabase, fromPath: string | null | undefined, toPath: string): Promise<boolean> {
  if (!fromPath || fromPath === toPath) return false;
  try {
    const buffer = await downloadFromStorage(supabase, fromPath, BUCKET);
    await uploadToStorage(supabase, toPath, buffer, 'image/png', BUCKET);
    console.log(`[copy] ${fromPath} -> ${toPath}`);
    return true;
  } catch (err) {
    console.warn(`[skip-copy] ${fromPath} -> ${toPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function uploadLocalPng(supabase: Supabase, localPath: string, storagePath: string): Promise<boolean> {
  try {
    const buffer = await readFile(localPath);
    await uploadToStorage(supabase, storagePath, buffer, 'image/png', BUCKET);
    console.log(`[upload] ${localPath} -> ${storagePath}`);
    return true;
  } catch (err) {
    console.warn(`[skip-upload] ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function updateLayoutRows(supabase: Supabase) {
  const { data: rows, error } = await supabase
    .from('layout_template')
    .select('id,store,franchise,kind,slug,total_slots,template_storage_path,card_back_storage_path');

  if (error) throw new Error(`layout_template fetch failed: ${error.message}`);

  for (const row of rows ?? []) {
    const store = row.store as string;
    const franchise = row.franchise as Franchise;
    const slug = FRANCHISE_SLUG[franchise];
    if (!slug) continue;

    let templatePath: string | null = null;
    let cardBackPath: string | null = null;

    if (store === 'oripark' && row.kind === 'postal') {
      const fileName = row.slug === 'box_8x5' ? 'box_40.png' : `${row.total_slots}.png`;
      templatePath = `templates/oripark/postal/${slug}/${fileName}`;
      cardBackPath = row.slug === 'box_8x5'
        ? `card-backs/oripark/${slug}_box.png`
        : `card-backs/oripark/${slug}.png`;
      await copyStorageObject(supabase, row.template_storage_path, templatePath);
      await copyStorageObject(supabase, row.card_back_storage_path, cardBackPath);
    }

    if (store === 'oripark' && row.kind === 'store') {
      templatePath = `templates/oripark/store/${slug}/${row.total_slots}.png`;
      cardBackPath = `card-backs/oripark/${slug}.png`;
      const localPath = path.join(ORIPARK_STORE_DIR, oriparkStoreFileName(franchise, row.total_slots));
      const uploaded = ORIPARK_STORE_SLOTS.includes(row.total_slots as (typeof ORIPARK_STORE_SLOTS)[number])
        ? await uploadLocalPng(supabase, localPath, templatePath)
        : false;
      if (!uploaded) await copyStorageObject(supabase, row.template_storage_path, templatePath);
      await copyStorageObject(supabase, row.card_back_storage_path, cardBackPath);
    }

    if (store === 'manman' && row.kind === 'store') {
      const slotFromSlug = Number(String(row.slug).replace(/^store_/, ''));
      const slots = Number.isFinite(slotFromSlug) && slotFromSlug > 0 ? slotFromSlug : row.total_slots;
      templatePath = `templates/manman/store/${slug}/${slots}.png`;
      cardBackPath = `card-backs/manman/${slug}.png`;
      const localPath = path.join(MANMAN_STORE_DIR, manmanStoreFileName(franchise, slots));
      const uploaded = MANMAN_STORE_SLOTS.includes(slots as (typeof MANMAN_STORE_SLOTS)[number])
        ? await uploadLocalPng(supabase, localPath, templatePath)
        : false;
      if (!uploaded) await copyStorageObject(supabase, row.template_storage_path, templatePath);
      await copyStorageObject(supabase, row.card_back_storage_path, cardBackPath);
    }

    if (templatePath && cardBackPath) {
      const { error: updateError } = await supabase
        .from('layout_template')
        .update({
          template_storage_path: templatePath,
          card_back_storage_path: cardBackPath,
        })
        .eq('id', row.id);
      if (updateError) throw new Error(`layout_template update failed (${row.id}): ${updateError.message}`);
      console.log(`[layout_template] ${store}/${row.kind}/${franchise}/${row.slug}`);
    }
  }
}

async function updateAssetProfiles(supabase: Supabase) {
  const { data: profiles, error } = await supabase
    .from('asset_profile')
    .select('id,store,franchise,template_storage_path,card_back_storage_path,template_box_storage_path,card_back_box_storage_path');

  if (error) throw new Error(`asset_profile fetch failed: ${error.message}`);

  for (const profile of profiles ?? []) {
    if (profile.store !== 'oripark') continue;
    const franchise = profile.franchise as Franchise;
    const slug = FRANCHISE_SLUG[franchise];
    if (!slug) continue;

    const updates = {
      template_storage_path: `templates/oripark/postal/${slug}/40.png`,
      card_back_storage_path: `card-backs/oripark/${slug}.png`,
      template_box_storage_path: `templates/oripark/postal/${slug}/box_40.png`,
      card_back_box_storage_path: `card-backs/oripark/${slug}_box.png`,
    };

    await copyStorageObject(supabase, profile.template_storage_path, updates.template_storage_path);
    await copyStorageObject(supabase, profile.card_back_storage_path, updates.card_back_storage_path);
    await copyStorageObject(supabase, profile.template_box_storage_path, updates.template_box_storage_path);
    await copyStorageObject(supabase, profile.card_back_box_storage_path, updates.card_back_box_storage_path);

    const { error: updateError } = await supabase.from('asset_profile').update(updates).eq('id', profile.id);
    if (updateError) throw new Error(`asset_profile update failed (${profile.id}): ${updateError.message}`);
    console.log(`[asset_profile] ${profile.store}/${franchise}`);
  }
}

async function verify(supabase: Supabase) {
  const { data: layouts, error: layoutError } = await supabase
    .from('layout_template')
    .select('store,kind,franchise,slug,template_storage_path,card_back_storage_path')
    .in('store', ['oripark', 'manman']);
  if (layoutError) throw new Error(`layout verify failed: ${layoutError.message}`);

  const badLayouts = (layouts ?? []).filter((row) => {
    const store = row.store as string;
    const template = row.template_storage_path ?? '';
    const cardBack = row.card_back_storage_path ?? '';
    return !template.startsWith(`templates/${store}/`) || !cardBack.startsWith(`card-backs/${store}/`);
  });
  if (badLayouts.length > 0) {
    throw new Error(`共有パスが残っています: ${JSON.stringify(badLayouts, null, 2)}`);
  }

  const { data: profiles, error: profileError } = await supabase
    .from('asset_profile')
    .select('store,franchise,template_storage_path,card_back_storage_path,template_box_storage_path,card_back_box_storage_path')
    .eq('store', 'oripark');
  if (profileError) throw new Error(`asset_profile verify failed: ${profileError.message}`);

  const badProfiles = (profiles ?? []).filter((row) => {
    const paths = [
      row.template_storage_path,
      row.card_back_storage_path,
      row.template_box_storage_path,
      row.card_back_box_storage_path,
    ].filter(Boolean) as string[];
    return paths.some((value) => !value.includes('/oripark/'));
  });
  if (badProfiles.length > 0) {
    throw new Error(`asset_profile に共有パスが残っています: ${JSON.stringify(badProfiles, null, 2)}`);
  }

  console.log(`[verify] layout_template=${layouts?.length ?? 0}, asset_profile=${profiles?.length ?? 0}`);
}

async function main() {
  const supabase = await createSupabaseClientFromSecrets();
  await updateLayoutRows(supabase);
  await updateAssetProfiles(supabase);
  await verify(supabase);
  console.log('[done] template storage paths reconciled');
}

main().catch((err) => {
  console.error('[failed]', err);
  process.exit(1);
});
