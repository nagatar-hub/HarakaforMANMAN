BEGIN;

ALTER TABLE public.generated_page
  ADD COLUMN peleka_snapshot JSONB;

CREATE OR REPLACE FUNCTION public.allocate_tokyo_peleka_catalog_revision(
  p_run_id UUID,
  p_regenerating_page_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_run public.run%ROWTYPE;
  v_business_date DATE;
  v_revision INTEGER;
  v_page_count INTEGER;
  v_unready_count INTEGER;
  v_regenerating_page_count INTEGER;
  v_card_count INTEGER;
  v_unique_card_count INTEGER;
  v_owned_card_count INTEGER;
  v_publishable_count INTEGER;
  v_unique_source_count INTEGER;
  v_cards JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tokyo-peleka-catalog|' || p_run_id::TEXT, 0));

  SELECT * INTO target_run
  FROM public.run
  WHERE id = p_run_id
    AND store = 'manman-akihabara'
    AND tokyo_snapshot_id IS NOT NULL;
  IF target_run.id IS NULL THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog run not found';
  END IF;

  SELECT snapshot.business_date INTO v_business_date
  FROM public.tokyo_buyback_snapshot snapshot
  WHERE snapshot.id = target_run.tokyo_snapshot_id
    AND snapshot.store = target_run.store;
  IF v_business_date IS NULL THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog snapshot not found';
  END IF;

  WITH page_rows AS MATERIALIZED (
    SELECT page.id, page.status, page.card_ids
    FROM public.generated_page page
    WHERE page.run_id = target_run.id
      AND page.kind = 'store'
  ), page_cards AS MATERIALIZED (
    SELECT card_id
    FROM page_rows page,
      unnest(page.card_ids) AS card_id
  ), card_rows AS MATERIALIZED (
    SELECT
      page_cards.card_id,
      to_jsonb(card) AS card_json,
      card.source_shinsoku_id,
      card_run.store AS card_store
    FROM page_cards
    LEFT JOIN public.prepared_card card ON card.id = page_cards.card_id
    LEFT JOIN public.run card_run ON card_run.id = card.run_id
  ), publishable_cards AS MATERIALIZED (
    SELECT card_json, source_shinsoku_id
    FROM card_rows
    WHERE card_store = target_run.store
      AND NULLIF(btrim(source_shinsoku_id), '') IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM page_rows),
    (SELECT count(*) FROM page_rows
      WHERE status <> 'generated'
        AND NOT (p_regenerating_page_id IS NOT NULL
          AND id = p_regenerating_page_id
          AND status = 'pending')
        AND NOT (target_run.status = 'completed'
          AND target_run.generate_done_at IS NOT NULL
          AND status = 'failed')),
    (SELECT count(*) FROM page_rows
      WHERE id = p_regenerating_page_id
        AND status = 'pending'),
    (SELECT count(*) FROM page_cards),
    (SELECT count(DISTINCT card_id) FROM page_cards),
    (SELECT count(*) FROM card_rows WHERE card_store = target_run.store),
    (SELECT count(*) FROM publishable_cards),
    (SELECT count(DISTINCT source_shinsoku_id) FROM publishable_cards),
    (SELECT COALESCE(jsonb_agg(card_json ORDER BY source_shinsoku_id), '[]'::JSONB) FROM publishable_cards)
  INTO
    v_page_count, v_unready_count, v_regenerating_page_count,
    v_card_count, v_unique_card_count,
    v_owned_card_count, v_publishable_count, v_unique_source_count, v_cards;
  IF p_regenerating_page_id IS NOT NULL AND v_regenerating_page_count <> 1 THEN
    RAISE EXCEPTION 'Tokyo Peleka regenerating page is not pending in this run';
  END IF;
  IF v_page_count = 0 OR v_unready_count > 0 THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog pages are not fully generated';
  END IF;
  IF v_card_count <> v_unique_card_count THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog contains duplicate cards';
  END IF;
  IF v_owned_card_count <> v_card_count THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog contains missing or foreign-store cards';
  END IF;
  IF v_publishable_count <> v_unique_source_count THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog contains duplicate source IDs';
  END IF;
  IF v_publishable_count = 0
    AND NOT (target_run.status = 'completed' AND target_run.generate_done_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Initial Tokyo Peleka catalog must not be empty';
  END IF;

  INSERT INTO public.tokyo_peleka_catalog_revisions (run_id, last_revision)
  VALUES (target_run.id, 1)
  ON CONFLICT (run_id) DO UPDATE
  SET last_revision = public.tokyo_peleka_catalog_revisions.last_revision + 1,
      updated_at = now()
  RETURNING last_revision INTO v_revision;

  RETURN jsonb_build_object(
    'runId', target_run.id,
    'snapshotId', target_run.tokyo_snapshot_id,
    'businessDate', v_business_date,
    'generatedAt', target_run.started_at,
    'revision', v_revision,
    'cards', v_cards
  );
END;
$$;

-- Add postal pages to an already completed run without rewriting its store output.
CREATE OR REPLACE FUNCTION public.insert_tokyo_peleka_postal_pages(
  p_run_id UUID, p_snapshot_id UUID, p_business_date DATE, p_pages JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM public.run r JOIN public.tokyo_buyback_snapshot s ON s.id = r.tokyo_snapshot_id
  WHERE r.id = p_run_id AND r.store = 'manman-akihabara' AND r.status = 'completed'
    AND r.generate_done_at IS NOT NULL AND r.tokyo_snapshot_id = p_snapshot_id
    AND s.store = r.store AND s.business_date = p_business_date FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Completed Tokyo run does not match'; END IF;
  IF EXISTS (SELECT 1 FROM public.generated_page WHERE run_id = p_run_id AND (kind <> 'store' OR status <> 'generated'))
    OR NOT EXISTS (SELECT 1 FROM public.generated_page WHERE run_id = p_run_id AND kind = 'store') THEN
    RAISE EXCEPTION 'Store pages are incomplete or postal pages already exist';
  END IF;
  IF jsonb_typeof(p_pages) IS DISTINCT FROM 'array' OR jsonb_array_length(p_pages) = 0 THEN
    RAISE EXCEPTION 'Postal pages are required';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pages) p WHERE
    p->>'run_id' IS DISTINCT FROM p_run_id::TEXT OR p->>'kind' IS DISTINCT FROM 'postal'
    OR p->>'status' IS DISTINCT FROM 'generated' OR NULLIF(p->>'image_url', '') IS NULL
    OR p->'peleka_snapshot'->>'runId' IS DISTINCT FROM p_run_id::TEXT
    OR p->'peleka_snapshot'->>'snapshotId' IS DISTINCT FROM p_snapshot_id::TEXT
    OR p->'peleka_snapshot'->>'businessDate' IS DISTINCT FROM p_business_date::TEXT) THEN
    RAISE EXCEPTION 'Postal page identity is invalid';
  END IF;
  INSERT INTO public.generated_page (id, run_id, franchise, page_index, page_label, card_ids,
    layout_template_id, kind, status, display_name, peleka_snapshot, image_key, image_url)
  SELECT id, run_id, franchise, page_index, page_label, card_ids,
    layout_template_id, kind, status, display_name, peleka_snapshot, image_key, image_url
  FROM jsonb_populate_recordset(NULL::public.generated_page, p_pages);
END;
$$;
REVOKE ALL ON FUNCTION public.insert_tokyo_peleka_postal_pages(UUID, UUID, DATE, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_tokyo_peleka_postal_pages(UUID, UUID, DATE, JSONB) TO service_role;

COMMIT;
