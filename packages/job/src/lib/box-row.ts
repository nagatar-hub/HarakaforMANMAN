import { normalizeText } from '@haraka/shared';

type BoxRowLike = {
  card_name?: string | null;
  grade?: string | null;
};

const BRACKET_BOX_PREFIX_RE = /^\s*【\s*BOX\s*】/i;
const ONE_BOX_PREFIX_RE = /^\s*\[\s*1?\s*BOX\s*\]/i;

export function isBoxRow(row: BoxRowLike): boolean {
  const grade = normalizeText(row.grade ?? '').toUpperCase();
  if (grade === 'BOX') return true;

  const cardName = normalizeText(row.card_name ?? '');
  return BRACKET_BOX_PREFIX_RE.test(cardName) || ONE_BOX_PREFIX_RE.test(cardName);
}
