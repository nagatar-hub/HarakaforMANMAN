const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const OPERATOR_SESSION_COOKIE = 'haraka_operator_session';
export const OPERATOR_OAUTH_NONCE_COOKIE = 'haraka_operator_oauth_nonce';
export const OPERATOR_STATE_TTL_SECONDS = 10 * 60;
export const OPERATOR_SESSION_TTL_SECONDS = 12 * 60 * 60;

const OPERATOR_STATE_PREFIX = 'op1';
const OPERATOR_SESSION_PREFIX = 'ops1';
const MAX_SIGNED_VALUE_LENGTH = 4096;

export type OperatorAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
export type OperatorOAuthTarget = 'operator' | 'sheet' | 'kecak';


export type OperatorState = {
  target: OperatorOAuthTarget;
  nonce: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
};

export type OperatorSession = {
  email: string;
  issuedAt: number;
  expiresAt: number;
};

export type GoogleOperatorUser = {
  email: string;
  emailVerified: true;
};

type SignedPayload = {
  purpose: 'operator-oauth' | 'operator-session';
  target?: OperatorOAuthTarget;
  nonce?: string;
  return_to?: string;
  email?: string;
  iat: number;
  exp: number;
};

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): ArrayBuffer {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signValue(prefix: string, payload: SignedPayload, secret: string): Promise<string> {
  const encodedPayload = encodeBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${prefix}.${encodedPayload}`;
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    await importHmacKey(secret),
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyValue(
  token: string,
  expectedPrefix: string,
  secret: string,
): Promise<OperatorAuthResult<SignedPayload>> {
  if (!token || token.length > MAX_SIGNED_VALUE_LENGTH) {
    return { ok: false, error: 'Invalid signed value' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== expectedPrefix) {
    return { ok: false, error: 'Invalid signed value' };
  }

  try {
    const verified = await globalThis.crypto.subtle.verify(
      'HMAC',
      await importHmacKey(secret),
      decodeBase64Url(parts[2]),
      textEncoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!verified) return { ok: false, error: 'Signature mismatch' };

    const parsed = JSON.parse(textDecoder.decode(decodeBase64Url(parts[1]))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Invalid signed payload' };
    }
    return { ok: true, value: parsed as SignedPayload };
  } catch {
    return { ok: false, error: 'Unable to verify signed value' };
  }
}

export function operatorAuthRequiredFromEnv(): boolean {
  return process.env.OPERATOR_AUTH_REQUIRED?.trim().toLowerCase() !== 'false';
}

export function operatorAuthSecretFromEnv(): OperatorAuthResult<string> {
  const secret = process.env.ORDER_LIST_IMPORT_API_TOKEN?.trim() ?? '';
  if (secret.length < 32) {
    return { ok: false, error: 'ORDER_LIST_IMPORT_API_TOKEN must be at least 32 characters' };
  }
  return { ok: true, value: secret };
}

export function safeRelativeReturnTo(value: string | null | undefined, fallback = '/runs'): string {
  const candidate = value?.trim() ?? '';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback;
  }
  try {
    const base = new URL('https://operator.invalid');
    const resolved = new URL(candidate, base);
    return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : fallback;
  } catch {
    return fallback;
  }
}

export function createOperatorNonce(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function isOperatorState(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(`${OPERATOR_STATE_PREFIX}.`));
}

export async function createOperatorState(params: {
  nonce: string;
  returnTo: string;
  target?: OperatorOAuthTarget;
  secret: string;
  nowSeconds?: number;
}): Promise<string> {
  const issuedAt = params.nowSeconds ?? nowInSeconds();
  return signValue(OPERATOR_STATE_PREFIX, {
    purpose: 'operator-oauth',
    nonce: params.nonce,
    target: params.target ?? 'operator',
    return_to: safeRelativeReturnTo(params.returnTo),
    iat: issuedAt,
    exp: issuedAt + OPERATOR_STATE_TTL_SECONDS,
  }, params.secret);
}

export async function verifyOperatorState(params: {
  state: string;
  nonceCookie: string | null | undefined;
  secret: string;
  nowSeconds?: number;
}): Promise<OperatorAuthResult<OperatorState>> {
  const verified = await verifyValue(params.state, OPERATOR_STATE_PREFIX, params.secret);
  if (!verified.ok) return verified;
  const payload = verified.value;
  const now = params.nowSeconds ?? nowInSeconds();
  const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
  const target = payload.target;
  const validTarget = target === 'operator' || target === 'sheet' || target === 'kecak';

  const returnTo = typeof payload.return_to === 'string' ? payload.return_to : '';
  if (payload.purpose !== 'operator-oauth'
    || !validTarget
    || !nonce
    || nonce !== params.nonceCookie
    || safeRelativeReturnTo(returnTo, '') !== returnTo
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || payload.iat > now + 60
    || payload.exp <= now
    || payload.exp - payload.iat > OPERATOR_STATE_TTL_SECONDS + 60) {
    return { ok: false, error: 'OAuth state is invalid or expired' };
  }
  return {
    ok: true,
    value: { nonce, returnTo, target, issuedAt: payload.iat, expiresAt: payload.exp },
  };
}

export async function createOperatorSession(params: {
  email: string;
  secret: string;
  nowSeconds?: number;
}): Promise<string> {
  const issuedAt = params.nowSeconds ?? nowInSeconds();
  return signValue(OPERATOR_SESSION_PREFIX, {
    purpose: 'operator-session',
    email: params.email.trim().toLowerCase(),
    iat: issuedAt,
    exp: issuedAt + OPERATOR_SESSION_TTL_SECONDS,
  }, params.secret);
}

export async function verifyOperatorSession(params: {
  session: string | null | undefined;
  secret: string;
  nowSeconds?: number;
}): Promise<OperatorAuthResult<OperatorSession>> {
  if (!params.session) return { ok: false, error: 'Operator session is missing' };
  const verified = await verifyValue(params.session, OPERATOR_SESSION_PREFIX, params.secret);
  if (!verified.ok) return verified;
  const payload = verified.value;
  const now = params.nowSeconds ?? nowInSeconds();
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (payload.purpose !== 'operator-session'
    || !email
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || payload.iat > now + 60
    || payload.exp <= now
    || payload.exp - payload.iat > OPERATOR_SESSION_TTL_SECONDS + 60) {
    return { ok: false, error: 'Operator session is invalid or expired' };
  }
  return { ok: true, value: { email, issuedAt: payload.iat, expiresAt: payload.exp } };
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function operatorEmailAllowlistFromEnv(): Set<string> {
  return new Set(
    (process.env.ORDER_LIST_OPERATOR_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function validateOperatorUserInfo(
  value: unknown,
  allowedEmails = operatorEmailAllowlistFromEnv(),
): OperatorAuthResult<GoogleOperatorUser> {
  if (allowedEmails.size === 0) {
    return { ok: false, error: 'ORDER_LIST_OPERATOR_EMAILS is not configured' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid Google userinfo response' };
  }
  const data = value as { email?: unknown; email_verified?: unknown };
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!email || data.email_verified !== true) {
    return { ok: false, error: 'A verified Google email address is required' };
  }
  if (!allowedEmails.has(email)) {
    return { ok: false, error: 'This Google account is not an allowed operator' };
  }
  return { ok: true, value: { email, emailVerified: true } };
}

export async function fetchGoogleOperatorUser(
  accessToken: string,
): Promise<OperatorAuthResult<GoogleOperatorUser>> {
  let response: Response;
  try {
    response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ok: false,
      error: `Unable to fetch Google userinfo: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: 'Unable to parse Google userinfo response' };
  }
  if (!response.ok) {
    return { ok: false, error: `Unable to fetch Google userinfo (${response.status})` };
  }
  return validateOperatorUserInfo(payload);
}
