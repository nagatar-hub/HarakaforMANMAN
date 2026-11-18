BEGIN;

-- A generation-scoped shop API response has no global checker sync run.
ALTER TABLE public.tokyo_buyback_snapshot ALTER COLUMN checker_run_id DROP NOT NULL;

-- Replace only the checker dependency, preserving the active lease, latest
-- order list, immutable snapshot ordering, price validation and service ACL.
DO $migration$
DECLARE
  definition TEXT := pg_get_functiondef('public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)'::regprocedure);
  old_clause TEXT := $old$  SELECT id INTO v_latest FROM public.kaitori_checker_sync_run
    WHERE store = v_snapshot.checker_source_store AND status = 'applied' ORDER BY created_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_snapshot.checker_run_id OR NOT EXISTS (
    SELECT 1 FROM public.kaitori_checker_sync_run WHERE id=v_latest AND status='applied'
      AND completed_at >= v_snapshot.fetched_at - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'latest applied checker run required' USING ERRCODE = '22023';
  END IF;$old$;
  new_clause TEXT := $new$  IF v_snapshot.checker_run_id IS NOT NULL THEN
    -- Existing callers remain compatible, without the 24-hour global guard.
    SELECT id INTO v_latest FROM public.kaitori_checker_sync_run
      WHERE store = v_snapshot.checker_source_store AND status = 'applied' ORDER BY created_at DESC LIMIT 1;
    IF v_latest IS DISTINCT FROM v_snapshot.checker_run_id OR NOT EXISTS (
      SELECT 1 FROM public.kaitori_checker_sync_run WHERE id=v_latest AND status='applied' AND completed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'latest applied checker run required' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_snapshot.checker_source_store IS DISTINCT FROM v_snapshot.store
      OR p_snapshot #>> '{report,checker_api,api_base}' IS DISTINCT FROM 'https://apn.kaitori-checker.com'
      OR p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11,44,51,54,55]'::jsonb
      OR p_snapshot #> '{report,checker_api,condition_ids}' IS DISTINCT FROM '[2]'::jsonb
      OR p_snapshot #>> '{report,checker_api,fetched_at}' IS NULL THEN
      RAISE EXCEPTION 'Tokyo scoped checker API evidence required' USING ERRCODE = '22023';
    END IF;
    IF (p_snapshot #>> '{report,checker_api,fetched_at}')::timestamptz < v_snapshot.fetched_at
      OR (p_snapshot #>> '{report,checker_api,fetched_at}')::timestamptz > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'invalid checker API fetch time' USING ERRCODE = '22023';
    END IF;
  END IF;$new$;
BEGIN
  IF position('v_snapshot.store IS DISTINCT FROM ''manman-akihabara''' IN definition) = 0
    OR (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Tokyo checker publisher; no changes made';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END;
$migration$;

REVOKE ALL ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
