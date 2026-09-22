import type { Database, DbCardRow } from '@haraka/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isBoxRow } from './box-row.js';
import { normalizeShinsokuBoxProductName } from './shinsoku-box-price-source.js';

type ImageProduct = { id?: string; franchise: string; name: string; model_number: string | null; product_type: string };
type ImageMatch = { status: 'matched' | 'ambiguous' | 'missing'; imageUrl: string | null; dbCardId: string | null; candidates: DbCardRow[]; identityCandidates: DbCardRow[] };

function imageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const paths: Record<string, RegExp> = {
      'fexadnveyuqduiujewrc.supabase.co': /^\/storage\/v1\/object\/public\/(?:cards|goods)\//,
      'firebasestorage.googleapis.com': /^\/v0\/b\/pokeca-api\.appspot\.com\/o\//,
      'www.pokemon-card.com': /^\/assets\/images\//,
      'www.cardrush-pokemon.jp': /^\/(?:phone\/)?data\/cardrushpokemon\/product\//,
      'www.magicardshop.jp': /^\/data\/magi\/product\//,
      'pokeboon.com': /^\/jp\/wp-content\/uploads\//,
    };
    return paths[url.hostname]?.test(url.pathname) && /\.(?:png|jpe?g|webp)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function harakaImageUrl(row: DbCardRow): string | null {
  return imageUrl(row.alt_image_url) ?? (row.image_status === 'dead' ? null : imageUrl(row.image_url));
}

function numberKey(value: string | null): string {
  return (value ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
}

function nameKey(value: string, relaxed = false): string {
  let name = value.normalize('NFKC').replace(/\s/g, '')
    .replace(/^(?:\[|【|\()?PSA10(?:\]|】|\))?/i, '')
    .replace(/(?:\[|【|\()?PSA10(?:\]|】|\))?$/i, '');
  if (relaxed) name = name.replace(/\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]/g, '')
    .replace(/(?:SAR|CSR|CHR|HRSA|SRSA|SSR|UR|HR|SR|AR|RRR|RR|SA)$/i, '');
  return name;
}

function boxName(name: string, franchise: string): string {
  const normalized = normalizeShinsokuBoxProductName(name);
  return franchise === 'ONE PIECE' ? normalized.replace(/^(?:op|eb|prb)\d{2}/i, '') : normalized;
}

function targetAnnotationsMatch(target: string, candidate: string): boolean {
  const normalized = target.normalize('NFKC').replace(/\s/g, '');
  const candidateName = candidate.normalize('NFKC').replace(/\s/g, '');
  const annotations = [...normalized.matchAll(/\(([^()]*)\)|【([^【】]*)】|\[([^\[\]]*)\]/g)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter(note => note && !/^(?:PSA10|SAR|CSR|CHR|HRSA|SRSA|SSR|UR|HR|SR|AR|RRR|RR|SA)$/i.test(note));
  // A bare target may use a numbered DB annotation, but an explicit variant
  // on the target must never disappear during relaxed matching.
  return annotations.every(note => candidateName.includes(note));
}

/** Exact identity wins. Relaxed names still require the complete nonempty PSA number. */
export function findHarakaImage(product: ImageProduct, dbRows: DbCardRow[]): ImageMatch {
  const missing: ImageMatch = { status: 'missing', imageUrl: null, dbCardId: null, candidates: [], identityCandidates: [] };
  if (!['psa', 'box'].includes(product.product_type)) return missing;
  const box = product.product_type === 'box';
  const number = numberKey(product.model_number);
  const scoped = dbRows.filter(row => row.store === 'manman-akihabara' && row.franchise === product.franchise
    && (box ? isBoxRow(row) : !isBoxRow(row) && ['PSA10', 'シングル'].includes(numberKey(row.grade))));
  if (!scoped.length) return missing;
  const rows = scoped.filter(row => box ? !number || !numberKey(row.list_no) || number === numberKey(row.list_no)
    : number && number === numberKey(row.list_no));
  const name = box ? boxName(product.name, product.franchise) : nameKey(product.name);
  if (!name) return missing;
  const exact = rows.filter(row => (box ? boxName(row.card_name, row.franchise) : nameKey(row.card_name)) === name);
  const relaxedName = nameKey(product.name, true);
  const candidates = exact.length || box ? exact : rows.filter(row => relaxedName && nameKey(row.card_name, true) === relaxedName
    && targetAnnotationsMatch(product.name, row.card_name));
  missing.identityCandidates = candidates;
  const usable = candidates.map(row => ({ row, url: harakaImageUrl(row) })).filter(entry => entry.url !== null);
  const urls = new Set(usable.map(entry => entry.url));
  if (!urls.size) {
    const reviewCandidates = scoped.filter(row => harakaImageUrl(row) && (box
      ? boxName(row.card_name, row.franchise) === name : relaxedName && nameKey(row.card_name, true) === relaxedName));
    if (reviewCandidates.length) return { ...missing, status: 'ambiguous', candidates: reviewCandidates };
  }
  if (urls.size !== 1) return { ...missing, status: urls.size > 1 ? 'ambiguous' : 'missing', candidates };
  const selected = usable.sort((a, b) => a.row.id.localeCompare(b.row.id))[0];
  return { status: 'matched', imageUrl: selected.url, dbCardId: selected.row.id, candidates, identityCandidates: candidates };
}

export async function loadTokyoHarakaCards(db: SupabaseClient<Database>): Promise<DbCardRow[]> {
  const rows: DbCardRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('db_card').select('*').eq('store', 'manman-akihabara').order('id').range(offset, offset + 999);
    if (error) throw new Error(`東京Haraka画像DB取得失敗: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  return rows;
}
