const LOCAL_API_URL = 'http://localhost:8080';

export function serverApiBaseUrl(): string {
  for (const candidate of [
    process.env.API_BASE_URL,
    process.env.NEXT_PUBLIC_API_URL,
    LOCAL_API_URL,
  ]) {
    const normalized = candidate?.replace(/^\uFEFF+/, '').trim();
    if (normalized) return normalized;
  }

  return LOCAL_API_URL;
}
