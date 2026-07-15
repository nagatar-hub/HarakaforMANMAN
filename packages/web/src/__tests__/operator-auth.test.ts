import {
  OPERATOR_SESSION_TTL_SECONDS,
  OPERATOR_STATE_TTL_SECONDS,
  createOperatorSession,
  createOperatorState,
  safeRelativeReturnTo,
  validateOperatorUserInfo,
  verifyOperatorSession,
  verifyOperatorState,
} from '@/lib/operator-auth';

const secret = 's'.repeat(32);
const now = 1_700_000_000;

function tamper(value: string): string {
  const final = value.at(-1);
  return value.slice(0, -1) + (final === 'A' ? 'B' : 'A');
}

describe('operator OAuth state', () => {
  test('accepts a correctly signed state with matching nonce and safe return path', async () => {
    const state = await createOperatorState({
      nonce: 'nonce-1',
      returnTo: '/runs?tab=imports',
      secret,
      nowSeconds: now,
    });

    await expect(verifyOperatorState({
      state,
      nonceCookie: 'nonce-1',
      secret,
      nowSeconds: now + 30,
    })).resolves.toEqual({
      ok: true,
      value: {
        nonce: 'nonce-1',
        target: 'operator',
        returnTo: '/runs?tab=imports',
        issuedAt: now,
        expiresAt: now + OPERATOR_STATE_TTL_SECONDS,
      },
    });
  });

  test('rejects a tampered state', async () => {
    const state = await createOperatorState({
      nonce: 'nonce-1',
      returnTo: '/runs',
      secret,
      nowSeconds: now,
    });

    const result = await verifyOperatorState({
      state: tamper(state),
      nonceCookie: 'nonce-1',
      secret,
      nowSeconds: now + 1,
    });

    expect(result.ok).toBe(false);
  });

  test('rejects expired state and nonce mismatch', async () => {
    const state = await createOperatorState({
      nonce: 'nonce-1',
      returnTo: '/runs',
      secret,
      nowSeconds: now,
    });

    await expect(verifyOperatorState({
      state,
      nonceCookie: 'nonce-1',
      secret,
      nowSeconds: now + OPERATOR_STATE_TTL_SECONDS,
    })).resolves.toMatchObject({ ok: false });
    await expect(verifyOperatorState({
      state,
      nonceCookie: 'nonce-2',
      secret,
      nowSeconds: now + 1,
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('operator session', () => {
  test('validates a 12 hour session and normalizes email', async () => {
    const session = await createOperatorSession({
      email: ' Operator@Example.COM ',
      secret,
      nowSeconds: now,
    });

    await expect(verifyOperatorSession({
      session,
      secret,
      nowSeconds: now + 1,
    })).resolves.toEqual({
      ok: true,
      value: {
        email: 'operator@example.com',
        issuedAt: now,
        expiresAt: now + OPERATOR_SESSION_TTL_SECONDS,
      },
    });
  });

  test('rejects tampered and expired sessions', async () => {
    const session = await createOperatorSession({
      email: 'operator@example.com',
      secret,
      nowSeconds: now,
    });

    await expect(verifyOperatorSession({
      session: tamper(session),
      secret,
      nowSeconds: now + 1,
    })).resolves.toMatchObject({ ok: false });
    await expect(verifyOperatorSession({
      session,
      secret,
      nowSeconds: now + OPERATOR_SESSION_TTL_SECONDS,
    })).resolves.toMatchObject({ ok: false });
  });
});

describe('operator input validation', () => {
  test('allows only safe relative return paths', () => {
    expect(safeRelativeReturnTo('/runs?tab=imports#review')).toBe('/runs?tab=imports#review');
    expect(safeRelativeReturnTo('https://attacker.example/runs')).toBe('/runs');
    expect(safeRelativeReturnTo('//attacker.example/runs')).toBe('/runs');
    expect(safeRelativeReturnTo('/runs\\evil')).toBe('/runs');
  });

  test('allows only verified userinfo emails in the allowlist', () => {
    const allowlist = new Set(['operator@example.com']);

    expect(validateOperatorUserInfo({
      email: ' Operator@Example.COM ',
      email_verified: true,
    }, allowlist)).toEqual({
      ok: true,
      value: { email: 'operator@example.com', emailVerified: true },
    });
    expect(validateOperatorUserInfo({
      email: 'operator@example.com',
      email_verified: false,
    }, allowlist)).toMatchObject({ ok: false });
    expect(validateOperatorUserInfo({
      email: 'other@example.com',
      email_verified: true,
    }, allowlist)).toMatchObject({ ok: false });
    expect(validateOperatorUserInfo({
      email: 'operator@example.com',
      email_verified: true,
    }, new Set())).toMatchObject({ ok: false });
  });
});
