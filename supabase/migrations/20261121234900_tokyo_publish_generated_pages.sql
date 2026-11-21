-- Failed pages stay available for inspection and retry. Pending pages still block publication.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.allocate_tokyo_peleka_catalog_revision(uuid,uuid)'::regprocedure);
  previous text := $$WHERE page.run_id = target_run.id
      AND page.kind = 'store'$$;
BEGIN
  IF (length(definition) - length(replace(definition, previous, ''))) / length(previous) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Tokyo catalog publisher';
  END IF;
  EXECUTE replace(definition, previous, previous || $$ AND page.status <> 'failed'$$);
END
$migration$;
