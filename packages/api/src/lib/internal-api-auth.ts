import { timingSafeEqual } from 'node:crypto';

export type InternalApiAuthResult = 'authorized' | 'misconfigured' | 'unauthorized';

export function authorizeInternalApiRequest(
  authorization: string | undefined,
  expectedToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim(),
): InternalApiAuthResult {
  if (!expectedToken || expectedToken.length < 32) return 'misconfigured';
  if (!authorization?.startsWith('Bearer ')) return 'unauthorized';

  const actualToken = authorization.slice('Bearer '.length).trim();
  const expectedBytes = Buffer.from(expectedToken);
  const actualBytes = Buffer.from(actualToken);
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes)
    ? 'authorized'
    : 'unauthorized';
}
