export class OrderListLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderListLeaseLostError';
  }
}

export type OrderListLeaseStore = {
  renew(importId: string, heartbeatAt: string): Promise<void>;
};

export type OrderListLease = {
  renewNow(): Promise<void>;
  assertActive(): void;
  stop(): Promise<void>;
};

/**
 * Keeps a processing import leased while the Cloud Run task is alive.
 * Renewals are serialized so a slow Supabase request cannot create an
 * unbounded stack of overlapping heartbeat writes.
 */
export function startOrderListLease(
  store: OrderListLeaseStore,
  importId: string,
  intervalMs = 60_000,
): OrderListLease {
  let stopped = false;
  let lost: Error | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const renew = async (): Promise<void> => {
    if (stopped || lost) return;
    try {
      await store.renew(importId, new Date().toISOString());
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error));
    }
  };

  const queueRenewal = (): Promise<void> => {
    inFlight = inFlight.then(renew, renew);
    return inFlight;
  };

  const assertActive = (): void => {
    if (lost) {
      throw new OrderListLeaseLostError(`オーダーリスト処理リースを維持できません: ${lost.message}`);
    }
    if (stopped) {
      throw new OrderListLeaseLostError('オーダーリスト処理リースは終了済みです');
    }
  };


  const timer = setInterval(() => {
    void queueRenewal();
  }, intervalMs);
  timer.unref?.();

  return {
    async renewNow(): Promise<void> {
      await queueRenewal();
      assertActive();
    },
    assertActive,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
