import {
  findEligibleGenerationRun,
  getRunDisplayStatus,
  getRunPollingInterval,
  isLaunchPendingGenerateResponse,
  isRunActive,
} from '../app/runs/run-generation-state';

type TestRun = {
  id: string;
  status: string;
  plan_done_at: string | null;
  generate_done_at: string | null;
};

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: 'run-1',
    status: 'completed',
    plan_done_at: '2026-07-15T00:00:00Z',
    generate_done_at: null,
    ...overrides,
  };
}

test('selects the newest run only when it is completed, planned, and not generated', () => {
  const eligible = run({ id: 'eligible' });
  const olderEligible = run({ id: 'older-eligible' });

  expect(findEligibleGenerationRun([eligible, olderEligible])?.id).toBe('eligible');
});

test('does not fall back to an older run when the newest run is failed or already generated', () => {
  const generatedNewest = run({ id: 'generated', generate_done_at: '2026-07-15T01:00:00Z' });
  const olderEligible = run({ id: 'older-eligible' });

  expect(findEligibleGenerationRun([generatedNewest, olderEligible])).toBeNull();
  expect(findEligibleGenerationRun([run({ status: 'failed' }), olderEligible])).toBeNull();
});

test('does not select running, failed, unplanned, or generated runs', () => {
  expect(findEligibleGenerationRun([
    run({ status: 'running' }),
    run({ status: 'failed' }),
    run({ plan_done_at: null }),
    run({ generate_done_at: '2026-07-15T01:00:00Z' }),
  ])).toBeNull();
});

test('a generated run left as running is terminal for display and polling', () => {
  const generatedRunning = run({
    status: 'running',
    generate_done_at: '2026-07-15T01:00:00Z',
  });

  expect(isRunActive(generatedRunning)).toBe(false);
  expect(getRunDisplayStatus(generatedRunning)).toBe('completed');
  expect(isRunActive(run({ status: 'running', generate_done_at: null }))).toBe(true);
});

test('uses one fast interval while active and a slower interval while idle', () => {
  expect(getRunPollingInterval(true)).toBe(2_000);
  expect(getRunPollingInterval(false)).toBe(10_000);
});

test('recognizes an ambiguous launch response that retained the server claim', () => {
  expect(isLaunchPendingGenerateResponse({ launch_pending: true })).toBe(true);
  expect(isLaunchPendingGenerateResponse({ launch_pending: false })).toBe(false);
  expect(isLaunchPendingGenerateResponse(null)).toBe(false);
});
