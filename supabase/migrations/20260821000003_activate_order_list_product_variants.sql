-- Contract phase: run only after the expand migration and a compatible
-- six-column API/job revision are deployed. After this phase, rollback must
-- target that compatible revision rather than an older five-column caller.
BEGIN;

DROP INDEX IF EXISTS public.uix_db_card_identity_per_store;

CREATE OR REPLACE FUNCTION public.resolve_order_list_item_selections(
  p_import_id UUID,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB,
  p_allow_unresolved BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_store TEXT;
  v_import_status TEXT;
  v_structural_valid BOOLEAN;
  v_persistence_complete BOOLEAN;
  v_entry JSONB;
  v_item_id UUID;
  v_db_card_id UUID;
  v_duplicate_item_id UUID;
  v_item public.order_list_item%ROWTYPE;
  v_db_card public.db_card%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_card_name TEXT;
  v_grade TEXT;
  v_list_no TEXT;
  v_tag TEXT;
  v_image_url TEXT;
  v_alt_image_url TEXT;
  v_selection_fingerprint TEXT;
  v_identity_key TEXT;
  v_card_created BOOLEAN;
  v_created_count INT := 0;
  v_reused_count INT := 0;
  v_resolved_count INT := 0;
  v_unselected_count INT;
  v_invalid_count INT;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT store, status, structural_valid, persistence_complete
  INTO v_store, v_import_status, v_structural_valid, v_persistence_complete
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

  p_mappings := coalesce(p_mappings, '[]'::JSONB);
  p_new_cards := coalesce(p_new_cards, '[]'::JSONB);
  IF jsonb_typeof(p_mappings) <> 'array' OR jsonb_typeof(p_new_cards) <> 'array' THEN
    RAISE EXCEPTION 'mappings and new_cards must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings) + jsonb_array_length(p_new_cards) > 12000 THEN
    RAISE EXCEPTION 'too many selections: %',
      jsonb_array_length(p_mappings) + jsonb_array_length(p_new_cards)
      USING ERRCODE = '22023';
  END IF;

  -- Validate all JSON before performing writes.
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR nullif(btrim(v_entry ->> 'item_id'), '') IS NULL
      OR nullif(btrim(v_entry ->> 'db_card_id'), '') IS NULL THEN
      RAISE EXCEPTION 'each mapping requires item_id and db_card_id'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_entry ->> 'item_id')::UUID;
      v_db_card_id := (v_entry ->> 'db_card_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'mapping ids must be UUIDs'
        USING ERRCODE = '22023';
    END;
  END LOOP;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_new_cards)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR nullif(btrim(v_entry ->> 'item_id'), '') IS NULL
      OR nullif(btrim(v_entry ->> 'card_name'), '') IS NULL
      OR nullif(btrim(v_entry ->> 'tag'), '') IS NULL THEN
      RAISE EXCEPTION 'each new card requires item_id, card_name, and tag'
        USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_item_id := (v_entry ->> 'item_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'new card item_id must be a UUID'
        USING ERRCODE = '22023';
    END;

    v_card_name := btrim(v_entry ->> 'card_name');
    v_grade := coalesce(btrim(v_entry ->> 'grade'), '');
    v_list_no := coalesce(btrim(v_entry ->> 'list_no'), '');
    v_tag := btrim(v_entry ->> 'tag');
    v_alt_image_url := nullif(btrim(v_entry ->> 'alt_image_url'), '');
    IF length(v_card_name) > 300 OR length(v_tag) > 200
      OR length(v_grade) > 100 OR length(v_list_no) > 100 THEN
      RAISE EXCEPTION 'new card text field is too long'
        USING ERRCODE = '22023';
    END IF;
    IF length(coalesce(v_alt_image_url, '')) > 2048 THEN
      RAISE EXCEPTION 'new card alt_image_url is too long'
        USING ERRCODE = '22023';
    END IF;
    IF v_alt_image_url IS NOT NULL
      AND v_alt_image_url !~* '^https://(fexadnveyuqduiujewrc\.supabase\.co|firebasestorage\.googleapis\.com)(:443)?/' THEN
      RAISE EXCEPTION 'new card alt_image_url host is not allowed'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT selection.item_id
  INTO v_duplicate_item_id
  FROM (
    SELECT (value ->> 'item_id')::UUID AS item_id
    FROM jsonb_array_elements(p_mappings)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id
    FROM jsonb_array_elements(p_new_cards)
  ) AS selection
  GROUP BY selection.item_id
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate item_id in selections: %', v_duplicate_item_id
      USING ERRCODE = '22023';
  END IF;

  -- Existing mappings preserve the prior behavior: any non-invalid item may
  -- be explicitly remapped.
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    v_item_id := (v_entry ->> 'item_id')::UUID;
    v_db_card_id := (v_entry ->> 'db_card_id')::UUID;

    SELECT * INTO v_item
    FROM public.order_list_item
    WHERE id = v_item_id AND import_id = p_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_list_item not found: %', v_item_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_item.match_status = 'invalid' THEN
      RAISE EXCEPTION 'invalid order_list_item cannot be mapped: %', v_item_id
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_db_card
    FROM public.db_card
    WHERE id = v_db_card_id
      AND store = v_store;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'db_card not found: %', v_db_card_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_db_card.franchise <> v_item.franchise THEN
      RAISE EXCEPTION 'franchise mismatch'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.excel_product_mapping (
      store, franchise, excel_product_id, db_card_id, status, match_method,
      first_seen_import_id, last_seen_import_id, confirmed_at, confirmed_by, updated_at
    ) VALUES (
      v_store, v_item.franchise, v_item.excel_product_id, v_db_card.id, 'active', 'manual',
      p_import_id, p_import_id, v_now, 'web-ui', v_now
    )
    ON CONFLICT (store, franchise, excel_product_key) DO UPDATE SET
      db_card_id = EXCLUDED.db_card_id,
      status = 'active',
      match_method = 'manual',
      last_seen_import_id = p_import_id,
      confirmed_at = v_now,
      confirmed_by = 'web-ui',
      updated_at = v_now
    RETURNING * INTO v_mapping;

    UPDATE public.order_list_item
    SET mapping_id = v_mapping.id,
        db_card_id = v_db_card.id,
        selection_fingerprint = NULL,
        match_status = 'matched',
        match_method = 'manual',
        match_note = CASE WHEN v_import_status = 'applied'
          THEN '反映後に確定した対応です。次回取込から使用し、過去の出力には遡及しません'
          ELSE NULL END,
        match_candidates = jsonb_build_array(v_db_card.id),
        matched_at = v_now,
        updated_at = v_now
    WHERE id = v_item.id;
    v_resolved_count := v_resolved_count + 1;
  END LOOP;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_new_cards)
  LOOP
    v_item_id := (v_entry ->> 'item_id')::UUID;
    v_card_name := btrim(v_entry ->> 'card_name');
    v_grade := coalesce(btrim(v_entry ->> 'grade'), '');
    v_list_no := coalesce(btrim(v_entry ->> 'list_no'), '');
    v_tag := btrim(v_entry ->> 'tag');
    v_alt_image_url := nullif(btrim(v_entry ->> 'alt_image_url'), '');
    v_selection_fingerprint := md5(jsonb_build_array(
      lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g'))),
      lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g'))),
      lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g'))),
      v_tag,
      coalesce(v_alt_image_url, '')
    )::TEXT);

    SELECT * INTO v_item
    FROM public.order_list_item
    WHERE id = v_item_id AND import_id = p_import_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_list_item not found: %', v_item_id
        USING ERRCODE = 'P0002';
    END IF;
    -- A response-loss retry may reach an item already resolved by the exact
    -- same new-card choice. Treat it as a semantic reuse only when both the
    -- normalized card identity and the active Excel mapping still point to the
    -- current card; a different choice must never be silently accepted.
    IF v_item.match_status = 'matched' AND v_item.db_card_id IS NOT NULL THEN
      IF v_item.selection_fingerprint IS DISTINCT FROM v_selection_fingerprint THEN
        RAISE EXCEPTION 'new DB card retry material fields changed for item: %', v_item_id
          USING ERRCODE = '55000';
      END IF;
      SELECT * INTO v_db_card
      FROM public.db_card
      WHERE id = v_item.db_card_id
        AND store = v_store
        AND franchise = v_item.franchise
        AND source_product_id IN ('', v_item.excel_product_id);
      IF NOT FOUND
        OR lower(btrim(regexp_replace(normalize(v_db_card.card_name, NFKC), '[[:space:]]+', ' ', 'g')))
          <> lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g')))
        OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.grade, ''), NFKC), '[[:space:]]+', ' ', 'g')))
          <> lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g')))
        OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.list_no, ''), NFKC), '[[:space:]]+', ' ', 'g')))
          <> lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g'))) THEN
        RAISE EXCEPTION 'new DB card retry does not match resolved item: %', v_item_id
          USING ERRCODE = '55000';
      END IF;

      SELECT * INTO v_mapping
      FROM public.excel_product_mapping
      WHERE id = v_item.mapping_id
        AND store = v_store
        AND db_card_id = v_item.db_card_id
        AND franchise = v_item.franchise
        AND excel_product_key = lower(btrim(regexp_replace(
          normalize(v_item.excel_product_id, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'new DB card retry has no matching active Excel mapping: %', v_item_id
          USING ERRCODE = '55000';
      END IF;
      v_reused_count := v_reused_count + 1;
      v_resolved_count := v_resolved_count + 1;
      CONTINUE;
    ELSIF v_item.match_status NOT IN ('ambiguous', 'unmatched') THEN
      RAISE EXCEPTION 'new DB card requires an unresolved order_list_item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;

    -- Primary image always comes from the already-validated workbook row.
    v_image_url := v_item.image_url;
    IF length(coalesce(v_image_url, '')) > 2048 THEN
      RAISE EXCEPTION 'new card image_url is too long'
        USING ERRCODE = '22023';
    END IF;
    IF v_image_url IS NOT NULL AND v_image_url !~* '^https?://' THEN
      RAISE EXCEPTION 'new card image_url must use http or https'
        USING ERRCODE = '22023';
    END IF;
    IF v_image_url IS NULL AND v_alt_image_url IS NULL THEN
      RAISE EXCEPTION 'new card requires an Excel image or alt_image_url'
        USING ERRCODE = '22023';
    END IF;

    v_identity_key := concat_ws(
      '|', v_store, v_item.franchise, v_item.excel_product_id
    );
    PERFORM pg_advisory_xact_lock(hashtextextended(v_identity_key, 0));

    SELECT * INTO v_db_card
    FROM public.db_card
    WHERE store = v_store
      AND franchise = v_item.franchise
      AND source_product_id = v_item.excel_product_id
    FOR UPDATE;

    IF FOUND THEN
      v_card_created := FALSE;
    ELSE
      INSERT INTO public.db_card (
        store, franchise, tag, card_name, grade, list_no, image_url, alt_image_url,
        rarity_icon, sheet_row_number, image_status, source_product_id, updated_at
      ) VALUES (
        v_store, v_item.franchise, v_tag, v_card_name, v_grade, v_list_no,
        v_image_url, v_alt_image_url, NULL, NULL, 'unchecked',
        v_item.excel_product_id, v_now
      )
      ON CONFLICT (
        store, franchise, card_name, grade, list_no, source_product_id
      ) DO NOTHING
      RETURNING * INTO v_db_card;
      v_card_created := FOUND;

      IF NOT v_card_created THEN
        SELECT * INTO v_db_card
        FROM public.db_card
        WHERE store = v_store
          AND franchise = v_item.franchise
          AND source_product_id = v_item.excel_product_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'conflicting source db_card could not be loaded'
            USING ERRCODE = '40001';
        END IF;
      END IF;
    END IF;

    IF lower(btrim(regexp_replace(normalize(v_db_card.card_name, NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g')))
      OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.grade, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g')))
      OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.list_no, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g'))) THEN
      RAISE EXCEPTION 'source product identity changed for item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;

    IF NOT v_card_created THEN
      UPDATE public.db_card
      SET tag = CASE WHEN nullif(btrim(tag), '') IS NULL THEN v_tag ELSE tag END,
          image_url = coalesce(nullif(btrim(image_url), ''), v_image_url),
          alt_image_url = coalesce(nullif(btrim(alt_image_url), ''), v_alt_image_url),
          updated_at = v_now
      WHERE id = v_db_card.id
      RETURNING * INTO v_db_card;
    END IF;

    IF v_card_created THEN
      v_created_count := v_created_count + 1;
    ELSE
      v_reused_count := v_reused_count + 1;
    END IF;

    INSERT INTO public.excel_product_mapping (
      store, franchise, excel_product_id, db_card_id, status, match_method,
      first_seen_import_id, last_seen_import_id, confirmed_at, confirmed_by, updated_at
    ) VALUES (
      v_store, v_item.franchise, v_item.excel_product_id, v_db_card.id, 'active', 'manual',
      p_import_id, p_import_id, v_now, 'web-ui', v_now
    )
    ON CONFLICT (store, franchise, excel_product_key) DO UPDATE SET
      db_card_id = EXCLUDED.db_card_id,
      status = 'active',
      match_method = 'manual',
      last_seen_import_id = p_import_id,
      confirmed_at = v_now,
      confirmed_by = 'web-ui',
      updated_at = v_now
    RETURNING * INTO v_mapping;

    UPDATE public.order_list_item
    SET mapping_id = v_mapping.id,
        db_card_id = v_db_card.id,
        selection_fingerprint = v_selection_fingerprint,
        match_status = 'matched',
        match_method = 'manual',
        match_note = CASE WHEN v_import_status = 'applied'
          THEN '反映後に確定した対応です。次回取込から使用し、過去の出力には遡及しません'
          ELSE NULL END,
        match_candidates = jsonb_build_array(v_db_card.id),
        matched_at = v_now,
        updated_at = v_now
    WHERE id = v_item.id;
    v_resolved_count := v_resolved_count + 1;
  END LOOP;

  -- Recalculate import counters once for the complete batch.
  WITH per_franchise AS (
    SELECT
      franchise,
      count(*)::INT AS total,
      count(*) FILTER (WHERE match_status = 'matched')::INT AS matched,
      count(*) FILTER (WHERE match_status = 'ambiguous')::INT AS ambiguous,
      count(*) FILTER (WHERE match_status = 'unmatched')::INT AS unmatched,
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
      coalesce(sum(invalid), 0)::INT AS invalid,
      jsonb_build_object(
        'Pokemon', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0),
        'ONE PIECE', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0),
        'YU-GI-OH!', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0)
      ) || coalesce(jsonb_object_agg(
        franchise,
        jsonb_build_object(
          'total', total, 'matched', matched, 'ambiguous', ambiguous,
          'unmatched', unmatched, 'invalid', invalid
        )
      ), '{}'::JSONB) AS sheet_counts
    FROM per_franchise
  )
  UPDATE public.order_list_import AS target
  SET sheet_counts = counts.sheet_counts,
      total_rows = counts.total,
      matched_rows = counts.matched,
      ambiguous_rows = counts.ambiguous,
      unmatched_rows = counts.unmatched,
      invalid_rows = counts.invalid,
      valid_rows = counts.matched + counts.ambiguous + counts.unmatched,
      updated_at = v_now
  FROM aggregate_counts AS counts
  WHERE target.id = p_import_id;

  SELECT
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT
  INTO v_unselected_count, v_invalid_count
  FROM public.order_list_item
  WHERE import_id = p_import_id;

  IF v_unselected_count > 0 AND NOT coalesce(p_allow_unresolved, FALSE) THEN
    RAISE EXCEPTION 'unselected order_list_items remain: %', v_unselected_count
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'created', v_created_count,
    'reused', v_reused_count,
    'resolved', v_resolved_count,
    'unselected', v_unselected_count,
    'invalid', v_invalid_count,
    'action', 'noop',
    'created_count', v_created_count,
    'reused_count', v_reused_count,
    'resolved_count', v_resolved_count,
    'unselected_count', v_unselected_count,
    'invalid_count', v_invalid_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_list_item_selections(
  UUID, JSONB, JSONB, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_item_selections(
  UUID, JSONB, JSONB, BOOLEAN
) TO service_role;

COMMIT;
