import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import {
  buildAuthorizationUrl,
  getVerifierForState,
  exchangeCodeForTokens,
  getXCredentials,
} from '../lib/x-auth.js';
import { verifyCredentials } from '../lib/x-client.js';
import { STORE_NAME } from '../lib/store-scope.js';

const FRONTEND_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export const xCredentialRoutes = new Hono();

// List all credentials (tokens excluded for security)
xCredentialRoutes.get('/x/credentials', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('x_credential')
    .select('id, account_name, x_user_id, x_username, status, last_verified_at, is_default, token_expires_at, created_at, updated_at')
    .eq('store', STORE_NAME)
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
    const { data: existing, error: existingError } = await supabase
      .from('x_credential')
      .select('id')
      .eq('x_user_id', user.id)
      .eq('store', STORE_NAME)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    if (existing) {
      // Update existing credential
      const { error: updateError } = await supabase.from('x_credential').update({
        account_name: user.name || user.username,
        x_username: user.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt,
        status: 'active',
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any).eq('id', existing.id).eq('store', STORE_NAME);
      if (updateError) throw new Error(updateError.message);
    } else {
      // Check if any credentials exist for default logic
      const { count, error: countError } = await supabase
        .from('x_credential')
        .select('id', { count: 'exact', head: true })
        .eq('store', STORE_NAME);
      if (countError) throw new Error(countError.message);

      const { error: insertError } = await supabase.from('x_credential').insert({
        account_name: user.name || user.username,
        x_user_id: user.id,
        x_username: user.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt,
        status: 'active',
        last_verified_at: new Date().toISOString(),
        is_default: (count ?? 0) === 0, // First credential becomes default
        store: STORE_NAME,
      } as any);
      if (insertError) throw new Error(insertError.message);
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
    const { error: updateError } = await supabase.from('x_credential').update({
      status: 'active',
      x_user_id: user.id,
      x_username: user.username,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any).eq('id', id).eq('store', STORE_NAME);
    if (updateError) throw new Error(updateError.message);
    return c.json({ verified: true, user });
  } catch (e: any) {
    const supabase = createSupabaseClient();
    await supabase.from('x_credential').update({
      status: 'expired',
      updated_at: new Date().toISOString(),
    } as any).eq('id', id).eq('store', STORE_NAME);
    return c.json({ verified: false, error: e.message }, 400);
  }
});

// Set default credential (unset others)
xCredentialRoutes.post('/x/credentials/:id/set-default', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: owned, error: findError } = await supabase
    .from('x_credential')
    .select('id')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (findError) return c.json({ error: findError.message }, 500);
  if (!owned) return c.json({ error: 'Credential not found' }, 404);

  const updatedAt = new Date().toISOString();
  const { error: clearError } = await supabase
    .from('x_credential')
    .update({ is_default: false, updated_at: updatedAt } as any)
    .eq('store', STORE_NAME)
    .neq('id', id);
  if (clearError) return c.json({ error: clearError.message }, 500);

  const { error } = await supabase.from('x_credential').update({ is_default: true, updated_at: updatedAt } as any).eq('id', id).eq('store', STORE_NAME);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

// Delete credential
xCredentialRoutes.delete('/x/credentials/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('x_credential').delete().eq('id', id).eq('store', STORE_NAME).select('id').maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Credential not found' }, 404);
  return c.json({ success: true });
});
