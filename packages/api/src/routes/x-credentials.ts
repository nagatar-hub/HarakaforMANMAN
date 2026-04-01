import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import {
  buildAuthorizationUrl,
  getVerifierForState,
  exchangeCodeForTokens,
  getXCredentials,
} from '../lib/x-auth.js';
import { verifyCredentials } from '../lib/x-client.js';

const FRONTEND_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const xCredentialRoutes = new Hono();

// List all credentials (tokens excluded for security)
xCredentialRoutes.get('/x/credentials', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('x_credential')
    .select('id, account_name, x_user_id, x_username, status, last_verified_at, is_default, token_expires_at, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// Initiate OAuth 2.0 PKCE flow
xCredentialRoutes.get('/x/oauth/authorize', async (c) => {
  const { url } = buildAuthorizationUrl();
  return c.json({ url });
});

// OAuth callback - exchange code for tokens, save to DB
xCredentialRoutes.get('/x/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.redirect(`${FRONTEND_URL}/post/credentials?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return c.redirect(`${FRONTEND_URL}/post/credentials?error=${encodeURIComponent('Missing code or state')}`);
  }

  const verifier = getVerifierForState(state);
  if (!verifier) {
    return c.redirect(`${FRONTEND_URL}/post/credentials?error=${encodeURIComponent('Invalid or expired state. Please try again.')}`);
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, verifier);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Fetch user info
    const user = await verifyCredentials(tokens.access_token);

    const supabase = createSupabaseClient();

    // Check if this X account already exists
    const { data: existing } = await supabase
      .from('x_credential')
      .select('id')
      .eq('x_user_id', user.id)
      .single();

    if (existing) {
      // Update existing credential
      await supabase.from('x_credential').update({
        account_name: user.name || user.username,
        x_username: user.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt,
        status: 'active',
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any).eq('id', existing.id);
    } else {
      // Check if any credentials exist for default logic
      const { count } = await supabase
        .from('x_credential')
        .select('id', { count: 'exact', head: true });

      await supabase.from('x_credential').insert({
        account_name: user.name || user.username,
        x_user_id: user.id,
        x_username: user.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt,
        status: 'active',
        last_verified_at: new Date().toISOString(),
        is_default: (count ?? 0) === 0, // First credential becomes default
      } as any);
    }

    return c.redirect(`${FRONTEND_URL}/post/credentials?success=true&username=${encodeURIComponent(user.username)}`);
  } catch (e: any) {
    return c.redirect(`${FRONTEND_URL}/post/credentials?error=${encodeURIComponent(e.message)}`);
  }
});

// Verify credential (refresh if needed, then test)
xCredentialRoutes.post('/x/credentials/:id/verify', async (c) => {
  const id = c.req.param('id');
  try {
    const { accessToken } = await getXCredentials(id);
    const user = await verifyCredentials(accessToken);
    const supabase = createSupabaseClient();
    await supabase.from('x_credential').update({
      status: 'active',
      x_user_id: user.id,
      x_username: user.username,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any).eq('id', id);
    return c.json({ verified: true, user });
  } catch (e: any) {
    const supabase = createSupabaseClient();
    await supabase.from('x_credential').update({
      status: 'expired',
      updated_at: new Date().toISOString(),
    } as any).eq('id', id);
    return c.json({ verified: false, error: e.message }, 400);
  }
});

// Set default credential (unset others)
xCredentialRoutes.post('/x/credentials/:id/set-default', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  await supabase.from('x_credential').update({ is_default: false, updated_at: new Date().toISOString() } as any).neq('id', id);
  const { error } = await supabase.from('x_credential').update({ is_default: true, updated_at: new Date().toISOString() } as any).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

// Delete credential
xCredentialRoutes.delete('/x/credentials/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('x_credential').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
