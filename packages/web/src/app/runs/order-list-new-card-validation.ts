export const NEW_CARD_ALLOWED_IMAGE_HOSTS = [
  'fexadnveyuqduiujewrc.supabase.co',
  'firebasestorage.googleapis.com',
] as const;

const allowedImageHosts = new Set<string>(NEW_CARD_ALLOWED_IMAGE_HOSTS);

export function newCardAltImageUrlOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if (url.protocol !== 'https:'
    || (url.port && url.port !== '443')
    || !allowedImageHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`代替画像URLはhttpsかつ許可ホスト（${NEW_CARD_ALLOWED_IMAGE_HOSTS.join(' / ')}）で入力してください。`);
  }
  return url.toString();
}
