BEGIN;

-- Accept the new PSA10 + BOX scope while retaining BOX-only compatibility
-- during deployment and image rollback. All other publication checks stay intact.
DO $migration$
DECLARE
  definition TEXT := pg_get_functiondef('public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)'::regprocedure);
  old_clause TEXT := $old$OR p_snapshot #> '{report,checker_api,condition_ids}' IS DISTINCT FROM '[2]'::jsonb$old$;
  new_clause TEXT := $new$OR (
        p_snapshot #> '{report,checker_api,condition_ids}' IS DISTINCT FROM '[2]'::jsonb
        AND p_snapshot #> '{report,checker_api,condition_ids}' IS DISTINCT FROM '[1,2]'::jsonb
      )$new$;
BEGIN
  IF position('v_snapshot.store IS DISTINCT FROM ''manman-akihabara''' IN definition) = 0
    OR position($scope$p_snapshot #> '{report,checker_api,shop_ids}' IS DISTINCT FROM '[11,44,51,54,55]'::jsonb$scope$ IN definition) = 0
    OR (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Tokyo checker publisher; no changes made';
  END IF;
  EXECUTE replace(definition, old_clause, new_clause);
END;
$migration$;

-- Custom sheets store the same branch label shown by normal-sheet details.
-- Keep the existing store, rendering, item compatibility and override guards.
DO $migration$
DECLARE
  signature TEXT;
  definition TEXT;
  old_clause TEXT := $old$WHEN 'blue_rocket' THEN 'Blue Rocket'$old$;
  new_clause TEXT := $new$WHEN 'blue_rocket' THEN coalesce((
        SELECT coalesce(
          CASE WHEN jsonb_typeof(o.origin->'shopName') = 'string'
            THEN nullif(btrim(o.origin->>'shopName'), '') END,
          CASE WHEN jsonb_typeof(o.origin->'shopId') = 'number' THEN
            CASE (o.origin->>'shopId')::numeric
              WHEN 11 THEN 'Blue Rocket（ブルロケ）秋葉原店'
              WHEN 44 THEN 'Blue Rocket（ブルロケ）郵送買取'
              WHEN 51 THEN 'Blue Rocket（ブルロケ）秋葉原LAOX店'
              WHEN 54 THEN 'Blue Rocket（ブルロケ）大阪なんば日本橋店'
              WHEN 55 THEN 'Blue Rocket（ブルロケ）福岡買取専門店'
              ELSE 'Blue Rocket' END
          ELSE CASE
            WHEN o.origin->>'id' ~ '^api:laox:[1-9][0-9]*$' THEN 'Blue Rocket（ブルロケ）秋葉原LAOX店'
            WHEN o.origin->>'id' ~ '^api:akihabara:[1-9][0-9]*$' THEN 'Blue Rocket（ブルロケ）秋葉原店'
            ELSE 'Blue Rocket' END
          END
        )
        FROM jsonb_array_elements(p.origins) WITH ORDINALITY o(origin, ordinal)
        WHERE o.origin->>'source' = 'blue_rocket'
        ORDER BY o.ordinal LIMIT 1
      ), 'Blue Rocket')$new$;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.add_custom_buyback_shinsoku_items(uuid,text,text[])',
    'public.refresh_custom_buyback_shinsoku_prices(uuid,text,uuid,boolean)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF position('invalid Tokyo sheet' IN definition) = 0
      OR (length(definition) - length(replace(definition, old_clause, ''))) / length(old_clause) <> 1 THEN
      RAISE EXCEPTION 'Unexpected Tokyo custom sheet function %; no changes made', signature;
    END IF;
    EXECUTE replace(definition, old_clause, new_clause);
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
