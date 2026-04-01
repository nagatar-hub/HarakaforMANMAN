/**
 * Google OAuth ユーティリティ関数のユニットテスト
 *
 * TDDアプローチ: このテストが Green になる実装を src/lib/google-oauth.ts に書く
 */

import {
  buildAuthorizationUrl,
  buildTokenRequestBody,
  extractRefreshToken,
  validateEnvVars,
  type GoogleTokenResponse,
} from '@/lib/google-oauth';

describe('buildAuthorizationUrl', () => {
  const baseParams = {
    clientId: 'test-client-id',
    redirectUri: 'http://localhost:3001/api/auth/google/callback',
  };

  it('必須パラメータを含む認証URLを生成する', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.hostname).toBe('accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
  });

  it('client_id が URL に含まれる', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
  });

  it('redirect_uri が URL に含まれる', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/auth/google/callback'
    );
  });

  it('response_type=code が設定される', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('spreadsheets.readonly と drive.readonly スコープが設定される', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    const scope = parsed.searchParams.get('scope')!;
    expect(scope).toContain('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(scope).toContain('https://www.googleapis.com/auth/drive.readonly');
  });

  it('access_type=offline が設定される（refresh_token取得のため）', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('access_type')).toBe('offline');
  });

  it('prompt=consent が設定される（毎回refresh_tokenを取得するため）', () => {
    const url = buildAuthorizationUrl(baseParams);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });
});

describe('buildTokenRequestBody', () => {
  const params = {
    code: 'auth-code-abc',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/auth/google/callback',
  };

  it('URLSearchParams 形式の文字列を返す', () => {
    const body = buildTokenRequestBody(params);
    const parsed = new URLSearchParams(body);

    expect(parsed.get('code')).toBe('auth-code-abc');
    expect(parsed.get('client_id')).toBe('test-client-id');
    expect(parsed.get('client_secret')).toBe('test-client-secret');
    expect(parsed.get('redirect_uri')).toBe(
      'http://localhost:3001/api/auth/google/callback'
    );
    expect(parsed.get('grant_type')).toBe('authorization_code');
  });
});

describe('extractRefreshToken', () => {
  it('refresh_token を含むレスポンスから値を抽出する', () => {
    const tokenResponse: GoogleTokenResponse = {
      access_token: 'access-token-xyz',
      refresh_token: 'refresh-token-abc',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    };

    expect(extractRefreshToken(tokenResponse)).toBe('refresh-token-abc');
  });

  it('refresh_token がない場合は null を返す', () => {
    const tokenResponse: GoogleTokenResponse = {
      access_token: 'access-token-xyz',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    };

    expect(extractRefreshToken(tokenResponse)).toBeNull();
  });
});

describe('validateEnvVars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('必要な環境変数がすべて揃っている場合は値を返す', () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.NEXTAUTH_URL = 'http://localhost:3001';

    const result = validateEnvVars();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.clientId).toBe('client-id');
      expect(result.value.clientSecret).toBe('client-secret');
      expect(result.value.baseUrl).toBe('http://localhost:3001');
    }
  });

  it('NEXTAUTH_URL がない場合はデフォルト値 http://localhost:3001 を使う', () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    delete process.env.NEXTAUTH_URL;

    const result = validateEnvVars();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe('http://localhost:3001');
    }
  });

  it('GOOGLE_CLIENT_ID がない場合はエラーを返す', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';

    const result = validateEnvVars();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GOOGLE_CLIENT_ID');
    }
  });

  it('GOOGLE_CLIENT_SECRET がない場合はエラーを返す', () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    delete process.env.GOOGLE_CLIENT_SECRET;

    const result = validateEnvVars();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('GOOGLE_CLIENT_SECRET');
    }
  });
});
