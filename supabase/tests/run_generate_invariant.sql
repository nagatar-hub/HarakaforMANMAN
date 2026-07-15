\set ON_ERROR_STOP on
BEGIN;
SELECT plan(8);

INSERT INTO public.run (
  id, triggered_by, status, plan_done_at, generate_done_at, completed_at
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  'sql-generate-invariant', 'completed',
  clock_timestamp(), clock_timestamp(), clock_timestamp()
);

DO $test$
BEGIN
  BEGIN
    UPDATE public.run
    SET status = 'running'
    WHERE id = '40000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'generated Run unexpectedly returned to running';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$test$;
SELECT pass('generated Run cannot return to running');

INSERT INTO public.run (
  id, triggered_by, status, plan_done_at, generate_claimed_at, generate_claim_token
) VALUES (
  '40000000-0000-4000-8000-000000000002',
  'sql-generate-invariant', 'running', clock_timestamp(), clock_timestamp(),
  '40000000-0000-4000-8000-000000000099'
);
SELECT pass('pending generated Run may be running');

SELECT is(
  (SELECT generate_claimed_at IS NOT NULL
   FROM public.run
   WHERE id = '40000000-0000-4000-8000-000000000002'),
  true,
  'pending generated Run may carry a generation lease'
);

DO $test$
BEGIN
  BEGIN
    UPDATE public.run
    SET generate_claim_token = NULL
    WHERE id = '40000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'generation lease unexpectedly lost its fencing token';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$test$;
SELECT pass('generation lease timestamp and fencing token cannot diverge');

UPDATE public.run
SET status = 'completed', generate_claimed_at = NULL, generate_claim_token = NULL
WHERE id = '40000000-0000-4000-8000-000000000002';

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.run (
      id, triggered_by, status, plan_done_at
    ) VALUES (
      '40000000-0000-4000-8000-000000000003',
      'sql-generate-invariant', 'running', clock_timestamp()
    );
    RAISE EXCEPTION 'planned Run unexpectedly entered running without a fenced claim';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$test$;
SELECT pass('planned Run cannot enter running without a fenced generation claim');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.run (
      id, triggered_by, store, status, plan_done_at
    ) VALUES (
      '40000000-0000-4000-8000-000000000004',
      'sql-generate-invariant', 'manman', 'running', clock_timestamp()
    );
    RAISE EXCEPTION 'MANMAN planned Run unexpectedly entered running without a fenced claim';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$test$;
SELECT pass('MANMAN planned Run also requires a fenced generation claim');

INSERT INTO public.run (
  id, triggered_by, store, status, plan_done_at, generate_done_at, completed_at
) VALUES (
  '40000000-0000-4000-8000-000000000005',
  'sql-generate-invariant', 'manman', 'completed',
  clock_timestamp(), clock_timestamp(), clock_timestamp()
);
DO $test$
BEGIN
  BEGIN
    UPDATE public.run
    SET status = 'running'
    WHERE id = '40000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'generated MANMAN Run unexpectedly returned to running';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$test$;
SELECT pass('generated MANMAN Run cannot return to running');

SELECT lives_ok(
  $$
    INSERT INTO public.run (
      id, triggered_by, store, status, plan_done_at,
      generate_claimed_at, generate_claim_token
    ) VALUES (
      '40000000-0000-4000-8000-000000000006',
      'sql-generate-invariant', 'manman', 'running', clock_timestamp(),
      clock_timestamp(), '40000000-0000-4000-8000-000000000098'
    )
  $$,
  'MANMAN planned Run may run with a fenced generation claim'
);

SELECT * FROM finish();
ROLLBACK;
