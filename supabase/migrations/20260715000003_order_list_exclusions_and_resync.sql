-- Persist operator exclusions by normalized Excel product ID and support a
-- deliberate fresh sync of an already-applied workbook.

ALTER TABLE public.order_list_import
  ADD COLUMN IF NOT EXISTS excluded_rows INT NOT NULL DEFAULT 0
    CHECK (excluded_rows >= 0);

ALTER TABLE public.order_list_import
  ADD COLUMN IF NOT EXISTS order_list_sync_request_id UUID,
  ADD COLUMN IF NOT EXISTS order_list_sync_request_fingerprint TEXT;

ALTER TABLE public.run
  ADD COLUMN IF NOT EXISTS order_list_sync_request_id UUID,
  ADD COLUMN IF NOT EXISTS order_list_sync_request_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uix_run_order_list_sync_request
  ON public.run (order_list_sync_request_id)
  WHERE order_list_sync_request_id IS NOT NULL;
COMMENT ON COLUMN public.run.order_list_sync_request_id IS
  'Client-generated idempotency key for one deliberate order-list sync request';
COMMENT ON COLUMN public.run.order_list_sync_request_fingerprint IS
  'SHA-256 fingerprint of the exact order-list sync request payload';
COMMENT ON COLUMN public.order_list_import.order_list_sync_request_id IS
  'Request that owns the current confirmed or processing sync lease';
COMMENT ON COLUMN public.order_list_import.order_list_sync_request_fingerprint IS
  'SHA-256 fingerprint bound to the current confirmed or processing sync lease';

ALTER TABLE public.order_list_item
  DROP CONSTRAINT IF EXISTS order_list_item_match_status_check;
ALTER TABLE public.order_list_item
  ADD CONSTRAINT order_list_item_match_status_check
  CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'excluded', 'invalid'));

COMMENT ON COLUMN public.excel_product_mapping.status IS
  'active maps an Excel product to db_card; disabled permanently excludes that normalized Excel product ID until explicitly remapped';
COMMENT ON COLUMN public.order_list_import.excluded_rows IS
  'Structurally valid Excel rows intentionally excluded from DB import';

CREATE OR REPLACE FUNCTION public.resolve_order_list_item_exclusions(
  p_import_id UUID,
  p_exclusions JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_status TEXT;
  v_structural_valid BOOLEAN;
  v_persistence_complete BOOLEAN;
  v_entry JSONB;
  v_item_id UUID;
  v_duplicate_item_id UUID;
  v_item public.order_list_item%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_count INT := 0;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT status, structural_valid, persistence_complete
  INTO v_import_status, v_structural_valid, v_persistence_complete
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_import_status NOT IN ('parsed', 'failed', 'applied') THEN
    RAISE EXCEPTION 'order_list_import cannot be edited while %', v_import_status
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_structural_valid OR NOT v_persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  p_exclusions := coalesce(p_exclusions, '[]'::JSONB);
  IF jsonb_typeof(p_exclusions) <> 'array' THEN
    RAISE EXCEPTION 'exclusions must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_exclusions) > 12000 THEN
    RAISE EXCEPTION 'too many exclusions'
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_exclusions)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR nullif(btrim(v_entry ->> 'item_id'), '') IS NULL THEN
      RAISE EXCEPTION 'each exclusion requires item_id'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_entry ->> 'item_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'exclusion item_id must be a UUID'
        USING ERRCODE = '22023';
    END;
  END LOOP;

  SELECT (value ->> 'item_id')::UUID
  INTO v_duplicate_item_id
  FROM jsonb_array_elements(p_exclusions)
  GROUP BY (value ->> 'item_id')::UUID
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate item_id in exclusions: %', v_duplicate_item_id
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_exclusions)
  LOOP
    v_item_id := (v_entry ->> 'item_id')::UUID;
    SELECT * INTO v_item
    FROM public.order_list_item
    WHERE id = v_item_id AND import_id = p_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_list_item not found: %', v_item_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_item.match_status = 'invalid' THEN
      RAISE EXCEPTION 'invalid order_list_item cannot be excluded: %', v_item_id
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.excel_product_mapping (
      franchise, excel_product_id, db_card_id, status, match_method,
      first_seen_import_id, last_seen_import_id,
      confirmed_by, confirmed_at, updated_at
    ) VALUES (
      v_item.franchise, v_item.excel_product_id, NULL, 'disabled', NULL,
      p_import_id, p_import_id, 'web-ui', v_now, v_now
    )
    ON CONFLICT (franchise, excel_product_key) DO UPDATE SET
      excel_product_id = EXCLUDED.excel_product_id,
      db_card_id = NULL,
      status = 'disabled',
      match_method = NULL,
      last_seen_import_id = p_import_id,
      confirmed_by = 'web-ui',
      confirmed_at = v_now,
      updated_at = v_now
    RETURNING * INTO v_mapping;

    UPDATE public.order_list_item
    SET mapping_id = v_mapping.id,
        db_card_id = NULL,
        match_status = 'excluded',
        match_method = NULL,
        match_candidates = '[]'::JSONB,
        match_note = CASE WHEN v_import_status = 'applied'
          THEN '反映後にDB除外へ変更しました。次回以降のExcel取込から自動除外し、過去の出力には遡及しません'
          ELSE 'DBに含めない設定です。今後のExcel取込でも自動的に除外します'
        END,
        selection_fingerprint = NULL,
        matched_at = NULL,
        updated_at = v_now
    WHERE id = v_item.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('excluded', v_count, 'excluded_count', v_count, 'action', 'noop');
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_list_item_exclusions(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_item_exclusions(UUID, JSONB)
  TO service_role;

-- Recalculate mutable review counters. applied_summary remains the immutable
-- snapshot captured by finalize_order_list_sync.
CREATE OR REPLACE FUNCTION public.refresh_order_list_import_review_counts(
  p_import_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.order_list_import WHERE id = p_import_id
  ) THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;

  WITH per_franchise AS (
    SELECT
      franchise,
      count(*)::INT AS total,
      count(*) FILTER (WHERE match_status = 'matched')::INT AS matched,
      count(*) FILTER (WHERE match_status = 'ambiguous')::INT AS ambiguous,
      count(*) FILTER (WHERE match_status = 'unmatched')::INT AS unmatched,
      count(*) FILTER (WHERE match_status = 'excluded')::INT AS excluded,
      count(*) FILTER (WHERE match_status = 'invalid')::INT AS invalid
    FROM public.order_list_item
    WHERE import_id = p_import_id
    GROUP BY franchise
  ), aggregate_counts AS (
    SELECT
      coalesce(sum(total), 0)::INT AS total,
      coalesce(sum(matched), 0)::INT AS matched,
      coalesce(sum(ambiguous), 0)::INT AS ambiguous,
      coalesce(sum(unmatched), 0)::INT AS unmatched,
      coalesce(sum(excluded), 0)::INT AS excluded,
      coalesce(sum(invalid), 0)::INT AS invalid,
      jsonb_build_object(
        'Pokemon', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'ONE PIECE', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0),
        'YU-GI-OH!', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'excluded', 0, 'invalid', 0)
      ) || coalesce(jsonb_object_agg(
        franchise,
        jsonb_build_object(
          'total', total, 'matched', matched, 'ambiguous', ambiguous,
          'unmatched', unmatched, 'excluded', excluded, 'invalid', invalid
        )
      ), '{}'::JSONB) AS sheet_counts
    FROM per_franchise
  ), updated AS (
    UPDATE public.order_list_import AS target
    SET sheet_counts = counts.sheet_counts,
        total_rows = counts.total,
        matched_rows = counts.matched,
        ambiguous_rows = counts.ambiguous,
        unmatched_rows = counts.unmatched,
        excluded_rows = counts.excluded,
        invalid_rows = counts.invalid,
        valid_rows = counts.matched + counts.ambiguous + counts.unmatched + counts.excluded,
        updated_at = v_now
    FROM aggregate_counts AS counts
    WHERE target.id = p_import_id
    RETURNING counts.*
  )
  SELECT jsonb_build_object(
    'total', total, 'matched', matched, 'ambiguous', ambiguous,
    'unmatched', unmatched, 'excluded', excluded, 'invalid', invalid
  )
  INTO v_result
  FROM updated;

  RETURN coalesce(v_result, jsonb_build_object(
    'total', 0, 'matched', 0, 'ambiguous', 0,
    'unmatched', 0, 'excluded', 0, 'invalid', 0
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_order_list_import_review_counts(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_order_list_import_review_counts(UUID)
  TO service_role;
CREATE OR REPLACE FUNCTION public.resolve_order_list_review_changes(
  p_import_id UUID,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB,
  p_exclusions JSONB DEFAULT '[]'::JSONB,
  p_allow_unresolved BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_selection_result JSONB;
  v_exclusion_result JSONB;
  v_counts JSONB;
  v_duplicate_item_id UUID;
  v_entry JSONB;
  v_item_id UUID;
  v_unselected_count INT;
BEGIN
  p_mappings := coalesce(p_mappings, '[]'::JSONB);
  p_new_cards := coalesce(p_new_cards, '[]'::JSONB);
  p_exclusions := coalesce(p_exclusions, '[]'::JSONB);
  IF jsonb_typeof(p_mappings) <> 'array'
    OR jsonb_typeof(p_new_cards) <> 'array'
    OR jsonb_typeof(p_exclusions) <> 'array' THEN
    RAISE EXCEPTION 'mappings, new_cards, and exclusions must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings)
      + jsonb_array_length(p_new_cards)
      + jsonb_array_length(p_exclusions) > 12000 THEN
    RAISE EXCEPTION 'too many review changes'
      USING ERRCODE = '22023';
  END IF;

  -- Keep every review write on the same import -> item lock order used by the
  -- legacy selection/exclusion resolvers. This direct RPC is also used by the
  -- post-apply save endpoint, outside confirm/resync's existing import lock.
  PERFORM 1
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;

  -- A previously excluded item may be deliberately restored as a new DB card.
  -- Temporarily return only those selected rows to unmatched; every following
  -- validation/write is in this same transaction, so failures restore the
  -- disabled mapping and excluded item atomically.
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_new_cards)
  LOOP
    IF jsonb_typeof(v_entry) = 'object'
      AND nullif(btrim(v_entry ->> 'item_id'), '') IS NOT NULL THEN
      BEGIN
        v_item_id := (v_entry ->> 'item_id')::UUID;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'new card item_id must be a UUID'
          USING ERRCODE = '22023';
      END;
      UPDATE public.order_list_item
      SET match_status = 'unmatched',
          match_note = NULL,
          match_candidates = '[]'::JSONB,
          selection_fingerprint = NULL,
          matched_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = v_item_id
        AND import_id = p_import_id
        AND match_status = 'excluded';
    END IF;
  END LOOP;

  -- Existing mapping/new-card validation and writes remain the source of
  -- truth. TRUE defers the final unresolved check until exclusions are saved.
  v_selection_result := public.resolve_order_list_item_selections(
    p_import_id, p_mappings, p_new_cards, TRUE
  );
  v_exclusion_result := public.resolve_order_list_item_exclusions(
    p_import_id, p_exclusions
  );

  SELECT selection.item_id
  INTO v_duplicate_item_id
  FROM (
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_mappings)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_new_cards)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_exclusions)
  ) AS selection
  GROUP BY selection.item_id
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate item_id in review changes: %', v_duplicate_item_id
      USING ERRCODE = '22023';
  END IF;

  v_counts := public.refresh_order_list_import_review_counts(p_import_id);
  v_unselected_count := coalesce((v_counts ->> 'ambiguous')::INT, 0)
    + coalesce((v_counts ->> 'unmatched')::INT, 0);
  IF v_unselected_count > 0 AND NOT coalesce(p_allow_unresolved, FALSE) THEN
    RAISE EXCEPTION 'unselected order_list_items remain: %', v_unselected_count
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'created', coalesce((v_selection_result ->> 'created')::INT, 0),
    'reused', coalesce((v_selection_result ->> 'reused')::INT, 0),
    'resolved', coalesce((v_selection_result ->> 'resolved')::INT, 0),
    'excluded', coalesce((v_exclusion_result ->> 'excluded')::INT, 0),
    'matched', coalesce((v_counts ->> 'matched')::INT, 0),
    'excluded_total', coalesce((v_counts ->> 'excluded')::INT, 0),
    'unselected', v_unselected_count,
    'invalid', coalesce((v_counts ->> 'invalid')::INT, 0),
    'action', 'noop',
    'created_count', coalesce((v_selection_result ->> 'created')::INT, 0),
    'reused_count', coalesce((v_selection_result ->> 'reused')::INT, 0),
    'resolved_count', coalesce((v_selection_result ->> 'resolved')::INT, 0),
    'excluded_count', coalesce((v_exclusion_result ->> 'excluded')::INT, 0),
    'unselected_count', v_unselected_count,
    'invalid_count', coalesce((v_counts ->> 'invalid')::INT, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_list_review_changes(UUID, JSONB, JSONB, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_review_changes(UUID, JSONB, JSONB, JSONB, BOOLEAN)
  TO service_role;

CREATE OR REPLACE FUNCTION public.assert_order_list_review_replay(
  p_import_id UUID,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB,
  p_exclusions JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_entry JSONB;
  v_item_id UUID;
  v_duplicate_item_id UUID;
  v_item public.order_list_item%ROWTYPE;
BEGIN
  p_mappings := coalesce(p_mappings, '[]'::JSONB);
  p_new_cards := coalesce(p_new_cards, '[]'::JSONB);
  p_exclusions := coalesce(p_exclusions, '[]'::JSONB);
  IF jsonb_typeof(p_mappings) <> 'array'
    OR jsonb_typeof(p_new_cards) <> 'array'
    OR jsonb_typeof(p_exclusions) <> 'array' THEN
    RAISE EXCEPTION 'mappings, new_cards, and exclusions must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings)
      + jsonb_array_length(p_new_cards)
      + jsonb_array_length(p_exclusions) > 12000 THEN
    RAISE EXCEPTION 'too many review changes'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_order_list_selection_replay(
    p_import_id, p_mappings, p_new_cards
  );

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_exclusions)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR nullif(btrim(v_entry ->> 'item_id'), '') IS NULL THEN
      RAISE EXCEPTION 'each exclusion requires item_id'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_entry ->> 'item_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'exclusion item_id must be a UUID'
        USING ERRCODE = '22023';
    END;
  END LOOP;

  SELECT selection.item_id
  INTO v_duplicate_item_id
  FROM (
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_mappings)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_new_cards)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_exclusions)
  ) AS selection
  GROUP BY selection.item_id
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate item_id in review replay: %', v_duplicate_item_id
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_exclusions)
  LOOP
    v_item_id := (v_entry ->> 'item_id')::UUID;
    SELECT * INTO v_item
    FROM public.order_list_item
    WHERE id = v_item_id AND import_id = p_import_id;
    IF NOT FOUND
      OR v_item.match_status <> 'excluded'
      OR v_item.db_card_id IS NOT NULL THEN
      RAISE EXCEPTION 'exclusion retry does not match resolved item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.excel_product_mapping AS mapping
      WHERE mapping.id = v_item.mapping_id
        AND mapping.franchise = v_item.franchise
        AND mapping.excel_product_key = lower(btrim(regexp_replace(
          normalize(v_item.excel_product_id, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        AND mapping.status = 'disabled'
        AND mapping.db_card_id IS NULL
    ) THEN
      RAISE EXCEPTION 'exclusion retry has no matching disabled Excel mapping: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_order_list_review_replay(UUID, JSONB, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_order_list_review_replay(UUID, JSONB, JSONB, JSONB)
  TO service_role;
-- Initial confirmation keeps historical running/completed Run idempotency.
-- Deliberate re-sync is separated into queue_order_list_import_resync.
CREATE OR REPLACE FUNCTION public.confirm_order_list_import_review(
  p_import_id UUID,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB,
  p_exclusions JSONB DEFAULT '[]'::JSONB,
  p_allow_unresolved BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import public.order_list_import%ROWTYPE;
  v_run_id UUID;
  v_run_status TEXT;
  v_changes JSONB := '{}'::JSONB;
  v_persisted_count INT;
  v_matched INT;
  v_unselected INT;
  v_invalid INT;
  v_excluded INT;
  v_now TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_import
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  v_now := clock_timestamp();
  IF NOT v_import.structural_valid OR NOT v_import.persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::INT,
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT,
    count(*) FILTER (WHERE match_status = 'excluded')::INT
  INTO v_persisted_count, v_matched, v_unselected, v_invalid, v_excluded
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_persisted_count <> v_import.total_rows THEN
    RAISE EXCEPTION 'persisted order_list_item count mismatch: expected %, actual %',
      v_import.total_rows, v_persisted_count
      USING ERRCODE = '55000';
  END IF;

  SELECT id, status INTO v_run_id, v_run_status
  FROM public.run
  WHERE order_list_import_id = p_import_id
    AND status IN ('running', 'completed')
  ORDER BY started_at DESC, id DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_import.confirmation_allow_unresolved IS NOT NULL
      AND v_import.confirmation_allow_unresolved
        IS DISTINCT FROM coalesce(p_allow_unresolved, FALSE) THEN
      RAISE EXCEPTION 'allow_unresolved changed from the confirmed request'
        USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_order_list_review_replay(
      p_import_id, p_mappings, p_new_cards, p_exclusions
    );
    IF v_matched = 0 THEN
      RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', v_unselected, 'invalid', v_invalid,
      'matched', v_matched, 'excluded_total', v_excluded,
      'action', 'noop', 'launch_pending', FALSE,
      'import_id', p_import_id, 'status', v_import.status,
      'run_id', v_run_id, 'run_status', v_run_status
    );
  END IF;

  IF v_import.status = 'confirmed' THEN
    IF v_import.confirmation_allow_unresolved IS NOT NULL
      AND v_import.confirmation_allow_unresolved
        IS DISTINCT FROM coalesce(p_allow_unresolved, FALSE) THEN
      RAISE EXCEPTION 'allow_unresolved changed from the confirmed request'
        USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_order_list_review_replay(
      p_import_id, p_mappings, p_new_cards, p_exclusions
    );
    IF v_matched = 0 THEN
      RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.run WHERE status = 'running') THEN
      RAISE EXCEPTION 'another run is already running'
        USING ERRCODE = '55000';
    END IF;
    IF v_import.heartbeat_at IS NOT NULL
      AND v_import.heartbeat_at >= v_now - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object(
        'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
        'unselected', v_unselected, 'invalid', v_invalid,
        'matched', v_matched, 'excluded_total', v_excluded,
        'action', 'noop', 'launch_pending', TRUE,
        'launch_claimed_at', v_import.heartbeat_at,
        'import_id', p_import_id, 'status', 'confirmed'
      );
    END IF;
    UPDATE public.order_list_import
    SET heartbeat_at = v_now, updated_at = v_now
    WHERE id = p_import_id;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', v_unselected, 'invalid', v_invalid,
      'matched', v_matched, 'excluded_total', v_excluded,
      'action', 'start_job', 'launch_pending', TRUE,
      'launch_claimed_at', v_now,
      'import_id', p_import_id, 'status', 'confirmed'
    );
  END IF;

  IF v_import.status NOT IN ('parsed', 'failed') THEN
    RAISE EXCEPTION 'order_list_import cannot be confirmed while %', v_import.status
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_list_import
    WHERE id <> p_import_id AND status IN ('confirmed', 'processing')
  ) THEN
    RAISE EXCEPTION 'another order_list_import is already active'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.run WHERE status = 'running') THEN
    RAISE EXCEPTION 'another run is already running'
      USING ERRCODE = '55000';
  END IF;

  v_changes := public.resolve_order_list_review_changes(
    p_import_id, p_mappings, p_new_cards, p_exclusions, p_allow_unresolved
  );
  PERFORM public.refresh_order_list_import_review_counts(p_import_id);
  SELECT
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT,
    count(*) FILTER (WHERE match_status = 'excluded')::INT
  INTO v_matched, v_unselected, v_invalid, v_excluded
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_matched = 0 THEN
    RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_list_import
  SET status = 'confirmed',
      confirmation_allow_unresolved = coalesce(p_allow_unresolved, FALSE),
      error_summary = jsonb_build_object(
        'issues', coalesce(v_import.error_summary -> 'issues', '[]'::JSONB)
      ),
      confirmed_at = v_now,
      confirmed_by = 'web-ui',
      processing_started_at = NULL,
      heartbeat_at = v_now,
      failed_at = NULL,
      failure_message = NULL,
      updated_at = v_now
  WHERE id = p_import_id;

  RETURN jsonb_build_object(
    'created', coalesce((v_changes ->> 'created')::INT, 0),
    'reused', coalesce((v_changes ->> 'reused')::INT, 0),
    'resolved', coalesce((v_changes ->> 'resolved')::INT, 0),
    'excluded', coalesce((v_changes ->> 'excluded')::INT, 0),
    'unselected', v_unselected, 'invalid', v_invalid,
    'matched', v_matched, 'excluded_total', v_excluded,
    'action', 'start_job', 'launch_pending', TRUE,
    'launch_claimed_at', v_now,
    'import_id', p_import_id, 'status', 'confirmed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order_list_import_review(UUID, JSONB, JSONB, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_list_import_review(UUID, JSONB, JSONB, JSONB, BOOLEAN)
  TO service_role;
-- Save any review changes and queue an applied workbook for a brand-new Run in
-- the same transaction. A client request ID makes completed and delayed
-- replays idempotent without blocking a later, deliberately new request.
DROP FUNCTION IF EXISTS public.queue_order_list_import_resync(
  UUID, JSONB, JSONB, JSONB, BOOLEAN
);
DROP FUNCTION IF EXISTS public.queue_order_list_import_resync(
  UUID, UUID, JSONB, JSONB, JSONB, BOOLEAN
);
CREATE OR REPLACE FUNCTION public.queue_order_list_import_resync(
  p_import_id UUID,
  p_request_id UUID,
  p_request_fingerprint TEXT,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB,
  p_exclusions JSONB DEFAULT '[]'::JSONB,
  p_allow_unresolved BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import public.order_list_import%ROWTYPE;
  v_run_id UUID;
  v_run_status TEXT;
  v_request_run_import_id UUID;
  v_run_request_fingerprint TEXT;
  v_request_import_status TEXT;
  v_changes JSONB := '{}'::JSONB;
  v_persisted_count INT;
  v_matched INT;
  v_unselected INT;
  v_invalid INT;
  v_excluded INT;
  v_now TIMESTAMPTZ;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'order-list sync request_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_request_fingerprint IS NULL
    OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'order-list sync request_fingerprint must be lowercase SHA-256 hex'
      USING ERRCODE = '22023';
  END IF;

  -- Fast replay path after a Run has already been persisted. Status is
  -- deliberately unrestricted: running, completed, and failed all prove that
  -- this exact request was launched and must never create another Run.
  SELECT sync_run.id, sync_run.status, sync_run.order_list_import_id,
         sync_run.order_list_sync_request_fingerprint, request_import.status
  INTO v_run_id, v_run_status, v_request_run_import_id,
       v_run_request_fingerprint, v_request_import_status
  FROM public.run AS sync_run
  LEFT JOIN public.order_list_import AS request_import
    ON request_import.id = sync_run.order_list_import_id
  WHERE sync_run.order_list_sync_request_id = p_request_id;
  IF FOUND THEN
    IF v_request_run_import_id IS DISTINCT FROM p_import_id THEN
      RAISE EXCEPTION 'order-list sync request_id belongs to another import: %',
        p_request_id
        USING ERRCODE = '55000';
    END IF;
    IF v_run_request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'order-list sync request_id fingerprint mismatch: %',
        p_request_id
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', 0, 'invalid', 0, 'matched', 0, 'excluded_total', 0,
      'action', 'noop', 'launch_pending', FALSE,
      'request_id', p_request_id,
      'request_fingerprint', p_request_fingerprint,
      'import_id', p_import_id,
      'status', coalesce(v_request_import_status, 'applied'),
      'run_id', v_run_id, 'run_status', v_run_status
    );
  END IF;

  SELECT * INTO v_import
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  v_now := clock_timestamp();
  IF NOT v_import.structural_valid OR NOT v_import.persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::INT,
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT,
    count(*) FILTER (WHERE match_status = 'excluded')::INT
  INTO v_persisted_count, v_matched, v_unselected, v_invalid, v_excluded
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_persisted_count <> v_import.total_rows THEN
    RAISE EXCEPTION 'persisted order_list_item count mismatch: expected %, actual %',
      v_import.total_rows, v_persisted_count
      USING ERRCODE = '55000';
  END IF;

  -- The fast lookup can race the first job between queue commit and Run insert.
  -- Recheck after the import lock so a Run completed while we waited also wins.
  SELECT id, status, order_list_import_id,
         order_list_sync_request_fingerprint
  INTO v_run_id, v_run_status, v_request_run_import_id,
       v_run_request_fingerprint
  FROM public.run
  WHERE order_list_sync_request_id = p_request_id;
  IF FOUND THEN
    IF v_request_run_import_id IS DISTINCT FROM p_import_id THEN
      RAISE EXCEPTION 'order-list sync request_id belongs to another import: %',
        p_request_id
        USING ERRCODE = '55000';
    END IF;
    IF v_run_request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'order-list sync request_id fingerprint mismatch: %',
        p_request_id
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', v_unselected, 'invalid', v_invalid,
      'matched', v_matched, 'excluded_total', v_excluded,
      'action', 'noop', 'launch_pending', FALSE,
      'request_id', p_request_id,
      'request_fingerprint', p_request_fingerprint,
      'import_id', p_import_id, 'status', v_import.status,
      'run_id', v_run_id, 'run_status', v_run_status
    );
  END IF;

  IF v_import.status IN ('confirmed', 'processing') THEN
    IF v_import.order_list_sync_request_id IS DISTINCT FROM p_request_id
      OR v_import.order_list_sync_request_fingerprint
        IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'order-list sync request does not own the active import lease'
        USING ERRCODE = '55000';
    END IF;
    IF v_import.confirmation_allow_unresolved IS NOT NULL
      AND v_import.confirmation_allow_unresolved
        IS DISTINCT FROM coalesce(p_allow_unresolved, FALSE) THEN
      RAISE EXCEPTION 'allow_unresolved changed from the queued request'
        USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_order_list_review_replay(
      p_import_id, p_mappings, p_new_cards, p_exclusions
    );
    IF v_matched = 0 THEN
      RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_import.status = 'processing' THEN
    SELECT id, status INTO v_run_id, v_run_status
    FROM public.run
    WHERE order_list_import_id = p_import_id AND status = 'running'
    ORDER BY started_at DESC, id DESC
    LIMIT 1;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', v_unselected, 'invalid', v_invalid,
      'matched', v_matched, 'excluded_total', v_excluded,
      'action', 'noop', 'launch_pending', v_run_id IS NULL,
      'request_id', p_request_id,
      'request_fingerprint', p_request_fingerprint,
      'import_id', p_import_id, 'status', 'processing',
      'run_id', v_run_id, 'run_status', v_run_status
    );
  END IF;

  IF v_import.status = 'confirmed' THEN
    SELECT id, status INTO v_run_id, v_run_status
    FROM public.run
    WHERE order_list_import_id = p_import_id AND status = 'running'
    ORDER BY started_at DESC, id DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
        'unselected', v_unselected, 'invalid', v_invalid,
        'matched', v_matched, 'excluded_total', v_excluded,
        'action', 'noop', 'launch_pending', FALSE,
        'request_id', p_request_id,
        'request_fingerprint', p_request_fingerprint,
        'import_id', p_import_id, 'status', 'confirmed',
        'run_id', v_run_id, 'run_status', v_run_status
      );
    END IF;
    IF v_import.heartbeat_at IS NOT NULL
      AND v_import.heartbeat_at >= v_now - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object(
        'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
        'unselected', v_unselected, 'invalid', v_invalid,
        'matched', v_matched, 'excluded_total', v_excluded,
        'action', 'noop', 'launch_pending', TRUE,
        'launch_claimed_at', v_import.heartbeat_at,
        'request_id', p_request_id,
        'request_fingerprint', p_request_fingerprint,
        'import_id', p_import_id, 'status', 'confirmed'
      );
    END IF;
    IF EXISTS (SELECT 1 FROM public.run WHERE status = 'running') THEN
      RAISE EXCEPTION 'another run is already running'
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.order_list_import
    SET heartbeat_at = v_now, updated_at = v_now
    WHERE id = p_import_id;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0, 'excluded', 0,
      'unselected', v_unselected, 'invalid', v_invalid,
      'matched', v_matched, 'excluded_total', v_excluded,
      'action', 'start_job', 'launch_pending', TRUE,
      'launch_claimed_at', v_now,
      'request_id', p_request_id,
      'request_fingerprint', p_request_fingerprint,
      'import_id', p_import_id, 'status', 'confirmed'
    );
  END IF;

  IF v_import.status NOT IN ('applied', 'failed') THEN
    RAISE EXCEPTION 'order_list_import cannot be resynced while %', v_import.status
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_list_import
    WHERE id <> p_import_id AND status IN ('confirmed', 'processing')
  ) THEN
    RAISE EXCEPTION 'another order_list_import is already active'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.run WHERE status = 'running') THEN
    RAISE EXCEPTION 'another run is already running'
      USING ERRCODE = '55000';
  END IF;

  -- This call may create DB cards, activate mappings, or disable mappings. If
  -- any later queue invariant fails, all review writes roll back with it.
  v_changes := public.resolve_order_list_review_changes(
    p_import_id, p_mappings, p_new_cards, p_exclusions, p_allow_unresolved
  );
  PERFORM public.refresh_order_list_import_review_counts(p_import_id);
  SELECT
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT,
    count(*) FILTER (WHERE match_status = 'excluded')::INT
  INTO v_matched, v_unselected, v_invalid, v_excluded
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_matched = 0 THEN
    RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_list_import
  SET status = 'confirmed',
      order_list_sync_request_id = p_request_id,
      order_list_sync_request_fingerprint = p_request_fingerprint,
      confirmation_allow_unresolved = coalesce(p_allow_unresolved, FALSE),
      confirmed_at = v_now,
      confirmed_by = 'web-ui',
      processing_started_at = NULL,
      heartbeat_at = v_now,
      failed_at = NULL,
      failure_message = NULL,
      updated_at = v_now
  WHERE id = p_import_id;

  RETURN jsonb_build_object(
    'created', coalesce((v_changes ->> 'created')::INT, 0),
    'reused', coalesce((v_changes ->> 'reused')::INT, 0),
    'resolved', coalesce((v_changes ->> 'resolved')::INT, 0),
    'excluded', coalesce((v_changes ->> 'excluded')::INT, 0),
    'unselected', v_unselected, 'invalid', v_invalid,
    'matched', v_matched, 'excluded_total', v_excluded,
    'action', 'start_job', 'launch_pending', TRUE,
    'launch_claimed_at', v_now,
    'request_id', p_request_id,
    'request_fingerprint', p_request_fingerprint,
    'import_id', p_import_id, 'status', 'confirmed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.queue_order_list_import_resync(
  UUID, UUID, TEXT, JSONB, JSONB, JSONB, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_order_list_import_resync(
  UUID, UUID, TEXT, JSONB, JSONB, JSONB, BOOLEAN
) TO service_role;
-- A heartbeat renewal is fenced by the exact live Run and the import lease
-- owner, so a stale worker cannot extend a recovered successor's lease.
CREATE OR REPLACE FUNCTION public.renew_order_list_sync_lease(
  p_import_id UUID,
  p_run_id UUID,
  p_heartbeat_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_import_id IS NULL OR p_run_id IS NULL OR p_heartbeat_at IS NULL THEN
    RAISE EXCEPTION 'import_id, run_id, and heartbeat_at are required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.order_list_import AS target_import
  SET heartbeat_at = greatest(
        coalesce(target_import.heartbeat_at, p_heartbeat_at),
        p_heartbeat_at
      ),
      updated_at = greatest(
        coalesce(target_import.updated_at, p_heartbeat_at),
        p_heartbeat_at
      )
  WHERE target_import.id = p_import_id
    AND target_import.status = 'processing'
    AND EXISTS (
      SELECT 1
      FROM public.run AS active_run
      WHERE active_run.id = p_run_id
        AND active_run.status = 'running'
        AND active_run.order_list_import_id = target_import.id
        AND active_run.order_list_sync_request_id
          IS NOT DISTINCT FROM target_import.order_list_sync_request_id
        AND active_run.order_list_sync_request_fingerprint
          IS NOT DISTINCT FROM
            target_import.order_list_sync_request_fingerprint
    );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_order_list_sync_lease(
  UUID, UUID, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_order_list_sync_lease(
  UUID, UUID, TIMESTAMPTZ
) TO service_role;
-- Existing imports have no exclusions, but make historical per-franchise JSON
-- shape compatible with the new API/UI immediately after migration.
UPDATE public.order_list_import
SET sheet_counts = jsonb_set(
  jsonb_set(
    jsonb_set(sheet_counts, '{Pokemon,excluded}', '0'::JSONB, TRUE),
    '{ONE PIECE,excluded}', '0'::JSONB, TRUE
  ),
  '{YU-GI-OH!,excluded}', '0'::JSONB, TRUE
),
updated_at = updated_at;

-- Preserve the job-facing signature and add exclusion counts to the immutable
-- activation snapshot.
CREATE OR REPLACE FUNCTION public.finalize_order_list_sync(
  p_import_id UUID,
  p_run_id UUID,
  p_total_prepared INT,
  p_total_pages INT,
  p_completed_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.order_list_import
  SET status = 'applied',
      applied_summary = jsonb_build_object(
        'total', total_rows,
        'matched', matched_rows,
        'ambiguous', ambiguous_rows,
        'unmatched', unmatched_rows,
        'excluded', excluded_rows,
        'invalid', invalid_rows,
        'by_franchise', sheet_counts
      ),
      activated_at = p_completed_at,
      failed_at = NULL,
      failure_message = NULL,
      heartbeat_at = NULL,
      updated_at = p_completed_at
  WHERE id = p_import_id AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import is not processing: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.run
  SET total_prepared = p_total_prepared,
      total_pages = p_total_pages,
      plan_done_at = p_completed_at,
      status = 'completed',
      completed_at = p_completed_at
  WHERE id = p_run_id
    AND order_list_import_id = p_import_id
    AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run is not running for import: % / %', p_run_id, p_import_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_list_sync(UUID, UUID, INT, INT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_order_list_sync(UUID, UUID, INT, INT, TIMESTAMPTZ)
  TO service_role;

NOTIFY pgrst, 'reload schema';
