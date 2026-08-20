type FetchImplementation = typeof fetch;

function isNewSupabaseApiKey(key: string): boolean {
  return key.startsWith('sb_secret_') || key.startsWith('sb_publishable_');
}

/**
 * New Supabase API keys authenticate through `apikey`, not as JWT bearer tokens.
 * Preserve a real user Authorization header and legacy JWT-key behavior.
 */
export function createSupabaseApiKeyFetch(
  apiKey: string,
  fetchImpl: FetchImplementation = fetch,
): FetchImplementation {
  if (!isNewSupabaseApiKey(apiKey)) return fetchImpl;
  const apiKeyBearer = `Bearer ${apiKey}`;

  return async (input, init) => {
    const headers = new Headers(new Request(input, init).headers);
    if (headers.get('Authorization') === apiKeyBearer) headers.delete('Authorization');
    return fetchImpl(input, { ...init, headers });
  };
}
