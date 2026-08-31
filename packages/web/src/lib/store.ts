import 'server-only';

// This deployment identity must never come from a NEXT_PUBLIC value because
// both applications intentionally share one Supabase project.
export function resolveStoreName(
  env: Readonly<Record<string, unknown>> = process.env as unknown as Readonly<Record<string, unknown>>,
): string {
  return typeof env.STORE_NAME === 'string' ? env.STORE_NAME.trim() || 'manman' : 'manman';
}

export const STORE_NAME = resolveStoreName();
