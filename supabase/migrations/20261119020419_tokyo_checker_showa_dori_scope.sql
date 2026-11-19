BEGIN;

-- New generations fetch Showa-dori (11) only. Retain the previous five-shop
-- evidence during deployment and image rollback; every other guard stays intact.
DO $migration$
DECLARE
  definition TEXT := pg_get_functiondef('public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)'::regprocedure);
  old_clause TEXT := $old$OR p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11,44,51,54,55]'::jsonb$old$;
  new_clause TEXT := $new$OR (
        p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11]'::jsonb
        AND p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11,44,51,54,55]'::jsonb
      )$new$;
BEGIN
  IF position('v_snapshot.store IS DISTINCT FROM ''manman-akihabara''' IN definition) = 0
    OR position($scope$p_snapshot #> '{report,checker_api,condition_ids}' IS DISTINCT FROM '[1,2]'::jsonb$scope$ IN definition) = 0
    OR (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Tokyo checker publisher; no changes made';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
