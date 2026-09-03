import type { Database, OperatorAuditLogRow } from '@haraka/shared';
import { createSupabaseClient } from './supabase.js';
import { normalizeOperatorEmail } from './internal-api-auth.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;

type AuditInsert = Database['public']['Tables']['operator_audit_log']['Insert'];
type InsertAudit = (entry: AuditInsert) => Promise<void>;

export function buildOperatorAuditEntry(params: {
  store: string;
  actorEmail: string | undefined;
  method: string;
  url: string;
  statusCode: number;
  targetId?: string;
  auditReadMutation?: boolean;
  now?: () => string;
}): AuditInsert | null {
  const method = params.method.toUpperCase();
  const actorEmail = normalizeOperatorEmail(params.actorEmail);
  if ((!MUTATION_METHODS.has(method) && !params.auditReadMutation)
    || !actorEmail
    || params.statusCode < 100
    || params.statusCode > 599) return null;

  const requestPath = new URL(params.url).pathname.slice(0, 1000);
  const pathTarget = requestPath.split('/').reverse().find((part) => UUID_PATTERN.test(part));
  const requestedTarget = params.targetId?.trim() ?? '';
  const targetId = SAFE_TARGET_ID_PATTERN.test(requestedTarget) ? requestedTarget : pathTarget;
  return {
    store: params.store,
    actor_email: actorEmail,
    http_method: method as OperatorAuditLogRow['http_method'],
    request_path: requestPath,
    target_id: targetId || null,
    status_code: params.statusCode,
    created_at: (params.now ?? (() => new Date().toISOString()))(),
  };
}

export async function persistOperatorAudit(
  entry: AuditInsert,
  insertAudit: InsertAudit = async (value) => {
    const { error } = await createSupabaseClient().from('operator_audit_log').insert(value);
    if (error) throw error;
  },
): Promise<void> {
  try {
    await insertAudit(entry);
  } catch {
    console.error(JSON.stringify({ event: 'operator_audit', persistence: 'stderr', ...entry }));
  }
}
