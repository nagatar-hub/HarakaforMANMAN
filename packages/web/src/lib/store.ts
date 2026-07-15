import 'server-only';

// This deployment identity must never come from a NEXT_PUBLIC value because
// both applications intentionally share one Supabase project.
export const STORE_NAME = 'manman' as const;
