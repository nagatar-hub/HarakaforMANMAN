/**
 * NFC正規化 - GAS normalizeRange() の移植
 * 濁点・半濁点の結合文字を統合
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC');
}
