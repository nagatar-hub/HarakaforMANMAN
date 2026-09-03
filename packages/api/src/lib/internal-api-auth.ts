import { timingSafeEqual } from 'node:crypto';

export type InternalApiAuthResult = 'authorized' | 'misconfigured' | 'unauthorized';
export type InternalMutationAuthResult = InternalApiAuthResult | 'not_required' | 'operator_required';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

export function normalizeOperatorEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? '';
  const parts = email.split('@');
  return email.length <= 254
    && parts.length === 2
    && Boolean(parts[0])
    && Boolean(parts[1])
    && !/\s/u.test(email)
    ? email
    : null;
}

export function authorizeInternalMutationRequest(
  method: string,
  authorization: string | undefined,
  expectedToken = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim(),
  operatorEmail?: string,
): InternalMutationAuthResult {
  if (!MUTATION_METHODS.has(method.toUpperCase())) return 'not_required';
  const auth = authorizeInternalApiRequest(authorization, expectedToken);
  return auth === 'authorized' && !normalizeOperatorEmail(operatorEmail)
    ? 'operator_required'
    : auth;
}
