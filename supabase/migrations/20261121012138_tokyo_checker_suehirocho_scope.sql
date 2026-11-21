BEGIN;

-- Preserve both previous scopes so the running job can publish throughout rollout.
DO $migration$
DECLARE
  definition TEXT := pg_get_functiondef('public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)'::regprocedure);
  previous TEXT := $old$p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11]'::jsonb$old$;
BEGIN
  IF position('v_snapshot.store IS DISTINCT FROM ''manman-akihabara''' IN definition) = 0
    OR (length(definition) - length(replace(definition, previous, ''))) / length(previous) <> 1
    OR position('''[11,73]''::jsonb' IN definition) > 0 THEN
    RAISE EXCEPTION 'Unexpected Tokyo checker publisher; no changes made';
  END IF;
  EXECUTE replace(definition, previous, previous ||
    $new$
        AND p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11,73]'::jsonb$new$);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
