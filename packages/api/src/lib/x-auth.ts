import crypto from 'crypto';
import { createSupabaseClient } from './supabase.js';

const X_CLIENT_ID = process.env.X_CLIENT_ID!;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET!;
const X_OAUTH_CALLBACK_URL = process.env.X_OAUTH_CALLBACK_URL || 'http://localhost:8080/api/x/oauth/callback';
const SCOPES = 'tweet.read tweet.write users.read offline.access media.write';
const TOKEN_REFRESH_MARGIN_SEC = 600;

// In-memory PKCE store (state -> verifier)
const pkceStore = new Map<string, { verifier: string; createdAt: number }>();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore) {
    if (now - val.createdAt > 10 * 60 * 1000) pkceStore.delete(key);
  }
}, 5 * 60 * 1000);

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

export function buildAuthorizationUrl(): { url: string; state: string } {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = crypto.randomUUID();

  pkceStore.set(state, { verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_OAUTH_CALLBACK_URL,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `https://twitter.com/i/oauth2/authorize?${params.toString()}`,
    state,
  };
}

export function getVerifierForState(state: string): string | null {
  const entry = pkceStore.get(state);
  if (!entry) return null;
  pkceStore.delete(state);
  if (Date.now() - entry.createdAt > 10 * 60 * 1000) return null;
  return entry.verifier;
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: X_OAUTH_CALLBACK_URL,
    client_id: X_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const basicAuth = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${err}`);
  }

  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  }>;
}

export async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: X_CLIENT_ID,
  });

  const basicAuth = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  return res.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  }>;
}

export async function getXCredentials(credentialId: string): Promise<{ accessToken: string }> {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('x_credential')
    .select('*')
    .eq('id', credentialId)
    .single();
  if (error || !data) throw new Error('Credential not found: ' + credentialId);

  const row = data as any;
  if (!row.access_token || !row.refresh_token) {
    throw new Error('Credential has no tokens: ' + credentialId);
  }

  // Check if token needs refresh
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const now = Date.now();

  if (expiresAt - now < TOKEN_REFRESH_MARGIN_SEC * 1000) {
    // Refresh the token
    const refreshed = await refreshAccessToken(row.refresh_token);
    const newExpiresAt = new Date(now + refreshed.expires_in * 1000).toISOString();

    await supabase.from('x_credential').update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    } as any).eq('id', credentialId);

    return { accessToken: refreshed.access_token };
  }

  return { accessToken: row.access_token };
}

export async function getDefaultXCredentials(): Promise<{ id: string; accessToken: string }> {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('x_credential')
    .select('*')
    .eq('is_default', true)
    .eq('status', 'active')
    .single();
  if (error || !data) throw new Error('No active default X credential found');

  const row = data as any;
  const { accessToken } = await getXCredentials(row.id);
  return { id: row.id, accessToken };
}
