import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
export type GenerateRunClaim = Pick<RunRow, 'id' | 'status'> & {
  generate_claimed_at: string;
  generate_claim_token: string;
};

// haraka-generate の Task timeout (60分) より長くする。期限内の曖昧な
// Cloud Run 起動結果は再実行せず、二重起動を防ぐ。
export const GENERATE_CLAIM_LEASE_MS = 75 * 60 * 1000;

export interface GenerateRunClaimStore {
  recoverStaleUnstarted(staleBeforeIso: string): Promise<void>;
  findLatestEligible(): Promise<Pick<RunRow, 'id'> | null>;
  claimEligible(
    id: string,
    claimedAtIso: string,
    claimToken: string,
  ): Promise<GenerateRunClaim | null>;
  releaseUnstarted(id: string, claimToken: string, claimedAtIso: string): Promise<boolean>;
}

export class GenerateRunClaimError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'GenerateRunClaimError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseGenerateRunRequest(value: unknown):
  | { ok: true; runId: string | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, runId: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'JSONオブジェクトを指定してください' };
  }
  const runId = (value as { run_id?: unknown }).run_id;
  if (runId === undefined || runId === null || runId === '') return { ok: true, runId: null };
  if (typeof runId !== 'string' || !UUID_PATTERN.test(runId.trim())) {
    return { ok: false, error: 'run_idが正しくありません' };
  }
  return { ok: true, runId: runId.trim().toLowerCase() };
}

export async function claimGenerateRun(
  store: GenerateRunClaimStore,
  requestedRunId: string | null,
  now = new Date(),
  createClaimToken: () => string = randomUUID,
): Promise<GenerateRunClaim> {
  const claimedAtIso = now.toISOString();
  const staleBeforeIso = new Date(now.getTime() - GENERATE_CLAIM_LEASE_MS).toISOString();
  await store.recoverStaleUnstarted(staleBeforeIso);

  const target = requestedRunId
    ? { id: requestedRunId }
    : await store.findLatestEligible();
  if (!target) {
    throw new GenerateRunClaimError(
      '画像生成待ちのRunがありません。先にオーダーリストを反映してください。',
      404,
    );
  }

  const claimToken = createClaimToken();
  if (!UUID_PATTERN.test(claimToken)) {
    throw new Error('画像生成claim tokenのUUID生成に失敗しました');
  }
  const claimed = await store.claimEligible(target.id, claimedAtIso, claimToken);
  if (!claimed) {
    throw new GenerateRunClaimError(
      'このRunはすでに処理中、または画像生成済みです。実行履歴を更新してください。',
      409,
    );
  }
  return claimed;
}

export function createSupabaseGenerateRunClaimStore(
  supabase: SupabaseClient<Database>,
  storeName: string,
): GenerateRunClaimStore {
  return {
    async recoverStaleUnstarted(staleBeforeIso) {
      const { error } = await supabase
        .from('run')
        .update({
          status: 'completed',
          generate_claimed_at: null,
          generate_claim_token: null,
        })
        .eq('store', storeName)
        .eq('status', 'running')
        .is('generate_done_at', null)
        .is('postal_done_at', null)
        .is('store_done_at', null)
        .not('generate_claimed_at', 'is', null)
        .lt('generate_claimed_at', staleBeforeIso);
      if (error) throw new Error('期限切れ画像生成claimの解除に失敗しました: ' + error.message);
    },

    async findLatestEligible() {
      const { data, error } = await supabase
        .from('run')
        .select('id')
        .eq('store', storeName)
        .eq('status', 'completed')
        .not('plan_done_at', 'is', null)
        .is('generate_done_at', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error('画像生成対象Runの検索に失敗しました: ' + error.message);
      return data;
    },

    async claimEligible(id, claimedAtIso, claimToken) {
      const { data, error } = await supabase
        .from('run')
        .update({
          status: 'running',
          error_message: null,
          generate_claimed_at: claimedAtIso,
          generate_claim_token: claimToken,
        })
        .eq('id', id)
        .eq('store', storeName)
        .eq('status', 'completed')
        .not('plan_done_at', 'is', null)
        .is('generate_done_at', null)
        .select('id, status, generate_claimed_at, generate_claim_token')
        .maybeSingle();
      if (error) throw new Error('画像生成対象Runの確保に失敗しました: ' + error.message);
      if (!data) return null;
      if (!data.generate_claimed_at) {
        throw new Error('画像生成対象Runのclaim時刻が保存されませんでした');
      }
      if (!data.generate_claim_token) {
        throw new Error('画像生成対象Runのclaim tokenが保存されませんでした');
      }
      return {
        id: data.id,
        status: data.status,
        generate_claimed_at: data.generate_claimed_at,
        generate_claim_token: data.generate_claim_token,
      };
    },

    async releaseUnstarted(id, claimToken, claimedAtIso) {
      const { data, error } = await supabase
        .from('run')
        .update({
          status: 'completed',
          generate_claimed_at: null,
          generate_claim_token: null,
        })
        .eq('id', id)
        .eq('store', storeName)
        .eq('status', 'running')
        // tokenを主fence、時刻も併用し、古い起動リクエストによる解除を防ぐ。
        .eq('generate_claim_token', claimToken)
        .eq('generate_claimed_at', claimedAtIso)
        .is('generate_done_at', null)
        .is('postal_done_at', null)
        .is('store_done_at', null)
        .select('id')
        .maybeSingle();
      if (error) throw new Error('画像生成対象Runのclaim解除に失敗しました: ' + error.message);
      return Boolean(data);
    },
  };
}
