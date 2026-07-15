-- Preserve the material choices used for response-loss replay validation.
ALTER TABLE public.order_list_import
  ADD COLUMN IF NOT EXISTS confirmation_allow_unresolved BOOLEAN;
ALTER TABLE public.order_list_item
  ADD COLUMN IF NOT EXISTS selection_fingerprint TEXT;

-- Persist all review selections in one transaction. Counters are recalculated
-- once after the batch; the per-item resolver is deliberately not called.
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
  v_normalized_match_count INT;
  v_normalized_match_id UUID;
  v_card_created BOOLEAN;
  v_created_count INT := 0;
  v_reused_count INT := 0;
  v_resolved_count INT := 0;
  v_unselected_count INT;
  v_invalid_count INT;
  v_now TIMESTAMPTZ := now();
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
    WHERE id = v_db_card_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'db_card not found: %', v_db_card_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_db_card.franchise <> v_item.franchise THEN
      RAISE EXCEPTION 'franchise mismatch'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.excel_product_mapping (
      franchise, excel_product_id, db_card_id, status, match_method,
      first_seen_import_id, last_seen_import_id, confirmed_at, confirmed_by, updated_at
    ) VALUES (
      v_item.franchise, v_item.excel_product_id, v_db_card.id, 'active', 'manual',
      p_import_id, p_import_id, v_now, 'web-ui', v_now
    )
    ON CONFLICT (franchise, excel_product_key) DO UPDATE SET
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
        AND franchise = v_item.franchise;
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

    v_identity_key := concat_ws('|',
      v_item.franchise,
      lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g'))),
      lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g'))),
      lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g')))
    );
    PERFORM pg_advisory_xact_lock(hashtextextended(v_identity_key, 0));

    SELECT count(*)::INT, (array_agg(id ORDER BY id))[1]
    INTO v_normalized_match_count, v_normalized_match_id
    FROM public.db_card
    WHERE franchise = v_item.franchise
      AND lower(btrim(regexp_replace(normalize(card_name, NFKC), '[[:space:]]+', ' ', 'g')))
        = lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g')))
      AND lower(btrim(regexp_replace(normalize(coalesce(grade, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        = lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g')))
      AND lower(btrim(regexp_replace(normalize(coalesce(list_no, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        = lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g')));

    IF v_normalized_match_count > 1 THEN
      RAISE EXCEPTION 'multiple normalized db_card identities already exist for item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;

    IF v_normalized_match_count = 1 THEN
      SELECT * INTO v_db_card
      FROM public.db_card
      WHERE id = v_normalized_match_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'normalized db_card disappeared: %', v_normalized_match_id
          USING ERRCODE = '40001';
      END IF;
      v_card_created := FALSE;
      UPDATE public.db_card
      SET tag = CASE WHEN nullif(btrim(tag), '') IS NULL THEN v_tag ELSE tag END,
          image_url = coalesce(nullif(btrim(image_url), ''), v_image_url),
          alt_image_url = coalesce(nullif(btrim(alt_image_url), ''), v_alt_image_url),
          updated_at = v_now
      WHERE id = v_db_card.id
      RETURNING * INTO v_db_card;
    ELSE
      INSERT INTO public.db_card (
        franchise, tag, card_name, grade, list_no, image_url, alt_image_url,
        rarity_icon, sheet_row_number, image_status, updated_at
      ) VALUES (
        v_item.franchise, v_tag, v_card_name, v_grade, v_list_no,
        v_image_url, v_alt_image_url, NULL, NULL, 'unchecked', v_now
      )
      ON CONFLICT (franchise, card_name, grade, list_no) DO NOTHING
      RETURNING * INTO v_db_card;
      v_card_created := FOUND;

      IF NOT v_card_created THEN
        SELECT * INTO v_db_card
        FROM public.db_card
        WHERE franchise = v_item.franchise
          AND card_name = v_card_name
          AND grade = v_grade
          AND list_no = v_list_no
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'conflicting db_card could not be loaded'
            USING ERRCODE = '40001';
        END IF;
        UPDATE public.db_card
        SET tag = CASE WHEN nullif(btrim(tag), '') IS NULL THEN v_tag ELSE tag END,
            image_url = coalesce(nullif(btrim(image_url), ''), v_image_url),
            alt_image_url = coalesce(nullif(btrim(alt_image_url), ''), v_alt_image_url),
            updated_at = v_now
        WHERE id = v_db_card.id
        RETURNING * INTO v_db_card;
      END IF;
    END IF;

    IF v_card_created THEN
      v_created_count := v_created_count + 1;
    ELSE
      v_reused_count := v_reused_count + 1;
    END IF;

    INSERT INTO public.excel_product_mapping (
      franchise, excel_product_id, db_card_id, status, match_method,
      first_seen_import_id, last_seen_import_id, confirmed_at, confirmed_by, updated_at
    ) VALUES (
      v_item.franchise, v_item.excel_product_id, v_db_card.id, 'active', 'manual',
      p_import_id, p_import_id, v_now, 'web-ui', v_now
    )
    ON CONFLICT (franchise, excel_product_key) DO UPDATE SET
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

REVOKE ALL ON FUNCTION public.resolve_order_list_item_selections(UUID, JSONB, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_item_selections(UUID, JSONB, JSONB, BOOLEAN)
  TO service_role;

-- Validate non-empty retry payloads against the already-resolved state. This
-- function is service-role-only and is used by confirm's idempotent branches;
-- empty retries intentionally remain valid.
CREATE OR REPLACE FUNCTION public.assert_order_list_selection_replay(
  p_import_id UUID,
  p_mappings JSONB DEFAULT '[]'::JSONB,
  p_new_cards JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_entry JSONB;
  v_item_id UUID;
  v_db_card_id UUID;
  v_duplicate_item_id UUID;
  v_item public.order_list_item%ROWTYPE;
  v_db_card public.db_card%ROWTYPE;
  v_card_name TEXT;
  v_grade TEXT;
  v_list_no TEXT;
  v_tag TEXT;
  v_alt_image_url TEXT;
  v_selection_fingerprint TEXT;
BEGIN
  p_mappings := coalesce(p_mappings, '[]'::JSONB);
  p_new_cards := coalesce(p_new_cards, '[]'::JSONB);
  IF jsonb_typeof(p_mappings) <> 'array' OR jsonb_typeof(p_new_cards) <> 'array' THEN
    RAISE EXCEPTION 'mappings and new_cards must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings) + jsonb_array_length(p_new_cards) > 12000 THEN
    RAISE EXCEPTION 'too many selections'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings) + jsonb_array_length(p_new_cards) = 0 THEN
    RETURN;
  END IF;

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
  END LOOP;

  SELECT selection.item_id
  INTO v_duplicate_item_id
  FROM (
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_mappings)
    UNION ALL
    SELECT (value ->> 'item_id')::UUID AS item_id FROM jsonb_array_elements(p_new_cards)
  ) AS selection
  GROUP BY selection.item_id
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'duplicate item_id in selections: %', v_duplicate_item_id
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    v_item_id := (v_entry ->> 'item_id')::UUID;
    v_db_card_id := (v_entry ->> 'db_card_id')::UUID;
    SELECT * INTO v_item
    FROM public.order_list_item
    WHERE id = v_item_id
      AND import_id = p_import_id;
    IF NOT FOUND
      OR v_item.match_status <> 'matched'
      OR v_item.db_card_id IS DISTINCT FROM v_db_card_id THEN
      RAISE EXCEPTION 'mapping retry does not match resolved item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.excel_product_mapping AS mapping
      WHERE mapping.id = v_item.mapping_id
        AND mapping.db_card_id = v_db_card_id
        AND mapping.franchise = v_item.franchise
        AND mapping.excel_product_key = lower(btrim(regexp_replace(
          normalize(v_item.excel_product_id, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        AND mapping.status = 'active'
    ) THEN
      RAISE EXCEPTION 'mapping retry has no matching active Excel mapping: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
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
    WHERE id = v_item_id
      AND import_id = p_import_id;
    IF NOT FOUND
      OR v_item.match_status <> 'matched'
      OR v_item.db_card_id IS NULL
      OR v_item.selection_fingerprint IS DISTINCT FROM v_selection_fingerprint THEN
      RAISE EXCEPTION 'new DB card retry does not match resolved item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_db_card
    FROM public.db_card
    WHERE id = v_item.db_card_id
      AND franchise = v_item.franchise;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'new DB card retry target is missing: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
    IF lower(btrim(regexp_replace(normalize(v_db_card.card_name, NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_card_name, NFKC), '[[:space:]]+', ' ', 'g')))
      OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.grade, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_grade, NFKC), '[[:space:]]+', ' ', 'g')))
      OR lower(btrim(regexp_replace(normalize(coalesce(v_db_card.list_no, ''), NFKC), '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(normalize(v_list_no, NFKC), '[[:space:]]+', ' ', 'g'))) THEN
      RAISE EXCEPTION 'new DB card retry identity changed for item: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.excel_product_mapping AS mapping
      WHERE mapping.id = v_item.mapping_id
        AND mapping.db_card_id = v_item.db_card_id
        AND mapping.franchise = v_item.franchise
        AND mapping.excel_product_key = lower(btrim(regexp_replace(
          normalize(v_item.excel_product_id, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        AND mapping.status = 'active'
    ) THEN
      RAISE EXCEPTION 'new DB card retry has no matching active Excel mapping: %', v_item_id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_order_list_selection_replay(UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_order_list_selection_replay(UUID, JSONB, JSONB)
  TO service_role;


-- Atomically validate, resolve staged selections, and claim an import for job
-- launch. heartbeat_at is a five-minute launch lease: it closes the gap between
-- commit and creation of the Cloud Run run row, while a failed launcher can
-- clear the exact claim and make the import immediately retryable.
CREATE OR REPLACE FUNCTION public.confirm_order_list_import_selections(
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
  v_import public.order_list_import%ROWTYPE;
  v_run_id UUID;
  v_run_status TEXT;
  v_selection_result JSONB := '{}'::JSONB;
  v_persisted_item_count INT;
  v_matched_count INT;
  v_unselected_count INT;
  v_invalid_count INT;
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
  -- Use wall-clock time after the row lock is acquired. now() is the
  -- transaction start time and could predate a long lock wait.
  v_now := clock_timestamp();
  IF NOT v_import.structural_valid OR NOT v_import.persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::INT,
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT
  INTO v_persisted_item_count, v_matched_count, v_unselected_count, v_invalid_count
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_persisted_item_count <> v_import.total_rows THEN
    RAISE EXCEPTION 'persisted order_list_item count mismatch: expected %, actual %',
      v_import.total_rows, v_persisted_item_count
      USING ERRCODE = '55000';
  END IF;

  -- A running or completed run makes repeated confirmation idempotent.
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
    PERFORM public.assert_order_list_selection_replay(
      p_import_id, p_mappings, p_new_cards
    );

    IF v_matched_count = 0 THEN
      RAISE EXCEPTION 'order_list_import has no matched items: %', p_import_id
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0,
      'unselected', v_unselected_count, 'invalid', v_invalid_count,
      'matched', v_matched_count, 'action', 'noop',
      'launch_pending', FALSE,
      'import_id', p_import_id, 'status', v_import.status,
      'run_id', v_run_id, 'run_status', v_run_status
    );
  END IF;

  -- A confirmed row may be between DB commit and Cloud Run creating its run
  -- row. A fresh heartbeat owns that launch; concurrent callers must not start
  -- another job. An absent/expired lease can be atomically reclaimed.
  IF v_import.status = 'confirmed' THEN
    IF v_import.confirmation_allow_unresolved IS NOT NULL
      AND v_import.confirmation_allow_unresolved
        IS DISTINCT FROM coalesce(p_allow_unresolved, FALSE) THEN
      RAISE EXCEPTION 'allow_unresolved changed from the confirmed request'
        USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_order_list_selection_replay(
      p_import_id, p_mappings, p_new_cards
    );

    IF v_matched_count = 0 THEN
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
        'created', 0, 'reused', 0, 'resolved', 0,
        'unselected', v_unselected_count, 'invalid', v_invalid_count,
        'matched', v_matched_count, 'action', 'noop',
        'launch_pending', TRUE,
        'launch_claimed_at', v_import.heartbeat_at,
        'import_id', p_import_id, 'status', 'confirmed'
      );
    END IF;

    UPDATE public.order_list_import
    SET heartbeat_at = v_now,
        updated_at = v_now
    WHERE id = p_import_id;
    RETURN jsonb_build_object(
      'created', 0, 'reused', 0, 'resolved', 0,
      'unselected', v_unselected_count, 'invalid', v_invalid_count,
      'matched', v_matched_count, 'action', 'start_job',
      'launch_pending', TRUE,
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

  -- This nested function reuses the row lock and all of its writes remain in
  -- this transaction. Any validation below rolls the selections back.
  v_selection_result := public.resolve_order_list_item_selections(
    p_import_id, p_mappings, p_new_cards, p_allow_unresolved
  );

  SELECT
    count(*)::INT,
    count(*) FILTER (WHERE match_status = 'matched' AND db_card_id IS NOT NULL)::INT,
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT
  INTO v_persisted_item_count, v_matched_count, v_unselected_count, v_invalid_count
  FROM public.order_list_item
  WHERE import_id = p_import_id;
  IF v_persisted_item_count <> v_import.total_rows THEN
    RAISE EXCEPTION 'persisted order_list_item count mismatch after selections: expected %, actual %',
      v_import.total_rows, v_persisted_item_count
      USING ERRCODE = '55000';
  END IF;
  IF v_matched_count = 0 THEN
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
    'created', coalesce((v_selection_result ->> 'created')::INT, 0),
    'reused', coalesce((v_selection_result ->> 'reused')::INT, 0),
    'resolved', coalesce((v_selection_result ->> 'resolved')::INT, 0),
    'unselected', v_unselected_count,
    'invalid', v_invalid_count,
    'matched', v_matched_count,
    'action', 'start_job',
    'launch_pending', TRUE,
    'launch_claimed_at', v_now,
    'import_id', p_import_id,
    'status', 'confirmed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order_list_import_selections(UUID, JSONB, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_list_import_selections(UUID, JSONB, JSONB, BOOLEAN)
  TO service_role;
