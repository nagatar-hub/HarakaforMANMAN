-- Scope Excel order-list imports and running jobs by store.
--
-- harakawebapp and HarakaforMANMAN share the same Supabase project. Existing
-- rows were created by the Oripark deployment, so the backfill/default is
-- intentionally `oripark`; the MANMAN services always write STORE_NAME.

ALTER TABLE public.order_list_import
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_order_list_import_store'
      AND conrelid = 'public.order_list_import'::regclass
  ) THEN
    ALTER TABLE public.order_list_import
      ADD CONSTRAINT chk_order_list_import_store CHECK (btrim(store) <> '');
  END IF;
END
$$;

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_file;

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_file_per_store;

ALTER TABLE public.order_list_import
  ADD CONSTRAINT uix_order_list_import_file_per_store
  UNIQUE (store, business_date, sha256);

DROP INDEX IF EXISTS public.uix_order_list_import_single_active;

CREATE UNIQUE INDEX IF NOT EXISTS uix_order_list_import_single_active_per_store
  ON public.order_list_import (store)
  WHERE status IN ('confirmed', 'processing');

CREATE INDEX IF NOT EXISTS idx_order_list_import_store_business_date
  ON public.order_list_import (store, business_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_list_import_store_status
  ON public.order_list_import (store, status, created_at DESC);

-- The original migration allowed only one running job across the shared
-- project. Runs already carry `store`, so isolate the guard per deployment.
DROP INDEX IF EXISTS public.uix_run_single_running;

CREATE UNIQUE INDEX IF NOT EXISTS uix_run_single_running_per_store
  ON public.run (store)
  WHERE status = 'running';

-- Store-scoped stale recovery for the MANMAN watchdog. The original RPC is
-- retained for the existing Oripark deployment until it is upgraded.
CREATE OR REPLACE FUNCTION public.recover_stale_order_list_imports_for_store(
  p_store TEXT,
  p_stale_before TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_ids UUID[];
  v_count INT := 0;
BEGIN
  IF nullif(btrim(p_store), '') IS NULL THEN
    RAISE EXCEPTION 'store is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(
    SELECT id
    FROM public.order_list_import
    WHERE store = p_store
      AND (
        (
          status = 'confirmed'
          AND coalesce(confirmed_at, updated_at, created_at) < p_stale_before
        ) OR (
          status = 'processing'
          AND coalesce(heartbeat_at, processing_started_at, updated_at, created_at) < p_stale_before
        )
      )
    FOR UPDATE
  )
  INTO v_import_ids;

  IF cardinality(v_import_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.run
  SET status = 'failed',
      error_message = '????????????',
      completed_at = now()
  WHERE store = p_store
    AND order_list_import_id = ANY(v_import_ids)
    AND status = 'running';

  UPDATE public.order_list_import
  SET status = 'failed',
      failed_at = now(),
      failure_message = '?????????????????2???????????????????',
      heartbeat_at = NULL,
      updated_at = now()
  WHERE store = p_store
    AND id = ANY(v_import_ids)
    AND status IN ('confirmed', 'processing');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_order_list_imports_for_store(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_order_list_imports_for_store(TEXT, TIMESTAMPTZ)
  TO service_role;
