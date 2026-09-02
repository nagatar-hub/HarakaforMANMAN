export type RunGenerationState = {
  status: string;
  plan_done_at: string | null;
  generate_done_at: string | null;
};

export function isRunActive(run: RunGenerationState): boolean {
  return run.status === 'running' && !run.generate_done_at;
}

export function findEligibleGenerationRun<T extends RunGenerationState>(runs: readonly T[]): T | null {
  const run = runs[0];
  return run && (
    run.status === 'completed'
    && Boolean(run.plan_done_at)
    && !run.generate_done_at
  ) ? run : null;
}

export function getRunDisplayStatus(run: RunGenerationState): string {
  if (run.status === 'running' && run.generate_done_at) return 'completed';
  return run.status;
}

export function getRunPollingInterval(hasActiveRun: boolean): number {
  return hasActiveRun ? 2_000 : 10_000;
}

export function isLaunchPendingGenerateResponse(payload: unknown): boolean {
  return Boolean(
    payload
    && typeof payload === 'object'
    && 'launch_pending' in payload
    && payload.launch_pending === true,
  );
}
