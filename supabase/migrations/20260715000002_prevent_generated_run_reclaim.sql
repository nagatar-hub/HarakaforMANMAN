-- A generated Run must never be moved back to running. The old generate
-- endpoint could reselect a generated completed Run and create a permanent
-- running row because the finalizer correctly refuses to rewrite
-- generate_done_at.
BEGIN;

ALTER TABLE public.run
  ADD COLUMN generate_claimed_at TIMESTAMPTZ,
  ADD COLUMN generate_claim_token UUID;

-- Serialize the legacy-row repair and invariant installation. Without this
-- lock, an old API/Job revision could reclaim a repaired row in between them.
LOCK TABLE public.run IN ACCESS EXCLUSIVE MODE;

UPDATE public.run
SET
  status = 'completed',
  completed_at = GREATEST(
    completed_at,
    generate_done_at,
    postal_done_at,
    store_done_at
  ),
  progress_current = 0,
  progress_total = 0,
  progress_message = NULL,
  progress_postal_current = 0,
  progress_postal_total = 0,
  progress_postal_message = NULL,
  progress_store_current = 0,
  progress_store_total = 0,
  progress_store_message = NULL,
  generate_claimed_at = NULL,
  generate_claim_token = NULL
WHERE store = 'oripark'
  AND status = 'running'
  AND generate_done_at IS NOT NULL;

-- Legacy in-flight generation rows had no lease metadata. Give planned,
-- ungenerated running rows a fresh fenced lease so the new watchdog can
-- recover them after the timeout window instead of leaving them permanent.
UPDATE public.run
SET
  generate_claimed_at = clock_timestamp(),
  generate_claim_token = gen_random_uuid()
WHERE store = 'oripark'
  AND status = 'running'
  AND plan_done_at IS NOT NULL
  AND generate_done_at IS NULL
  AND generate_claimed_at IS NULL
  AND generate_claim_token IS NULL;

ALTER TABLE public.run
  ADD CONSTRAINT run_running_requires_generate_pending
  CHECK (store <> 'oripark' OR status <> 'running' OR generate_done_at IS NULL),
  ADD CONSTRAINT run_generate_claim_pair
  CHECK ((generate_claimed_at IS NULL) = (generate_claim_token IS NULL)),
  ADD CONSTRAINT run_planned_running_requires_generate_claim
  CHECK (
    status <> 'running'
    OR store <> 'oripark'
    OR plan_done_at IS NULL
    OR (generate_claimed_at IS NOT NULL AND generate_claim_token IS NOT NULL)
  );

COMMENT ON CONSTRAINT run_running_requires_generate_pending ON public.run IS
  'Prevents an image-generated Run from being reclaimed and left permanently running.';

COMMENT ON COLUMN public.run.generate_claimed_at IS
  'Lease timestamp for a claimed image-generation Run; stale unstarted claims are recoverable after the Job timeout window.';

COMMENT ON COLUMN public.run.generate_claim_token IS
  'Immutable fencing token for one generation launch; delayed executions may only join the matching claim.';

COMMENT ON CONSTRAINT run_generate_claim_pair ON public.run IS
  'Generation lease timestamps and fencing tokens must be created and cleared atomically.';

COMMENT ON CONSTRAINT run_planned_running_requires_generate_claim ON public.run IS
  'A planned Run may enter running only through the fenced generation claim path.';

COMMIT;
