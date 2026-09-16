BEGIN;
-- Preserve the Tokyo-only publisher's lease, freshness, identity and ACL checks.
DO $$
DECLARE
  definition text := pg_get_functiondef('public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)'::regprocedure);
  old_clause text := 'WHERE store = v_snapshot.checker_source_store ORDER BY created_at DESC LIMIT 1;';
  new_clause text := 'WHERE store = v_snapshot.checker_source_store AND status = ''applied'' ORDER BY created_at DESC LIMIT 1;';
BEGIN
  IF position('v_snapshot.store IS DISTINCT FROM ''manman-akihabara''' IN definition) = 0 THEN
    RAISE EXCEPTION 'Expected Tokyo-only publisher';
  END IF;
  IF position(new_clause IN definition) > 0 AND position(old_clause IN definition) = 0 THEN RETURN; END IF;
  IF (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'Unexpected checker selector; no changes made';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
