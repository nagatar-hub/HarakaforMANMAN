-- Custom buyback sheets are isolated snapshots. They never mutate prepared_card,
-- generated_page, or the public buyback-sheet publication pipeline.

CREATE TABLE public.custom_buyback_sheet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  franchise TEXT NOT NULL CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  product_type TEXT NOT NULL CHECK (product_type IN ('psa', 'box')),
  kind TEXT NOT NULL CHECK (kind IN ('postal', 'store')),
  price_snapshot_run_id UUID NOT NULL REFERENCES public.run(id) ON DELETE RESTRICT,
  price_business_date DATE NOT NULL,
  display_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'rendering', 'ready', 'failed')),
  revision INT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_rendered_revision INT CHECK (last_rendered_revision IS NULL OR last_rendered_revision >= 0),
  error_message TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_custom_buyback_sheet_store_updated
  ON public.custom_buyback_sheet (store, updated_at DESC);

CREATE INDEX idx_custom_buyback_sheet_store_display_date
  ON public.custom_buyback_sheet (store, display_date DESC, updated_at DESC);

CREATE TABLE public.custom_buyback_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id UUID NOT NULL REFERENCES public.custom_buyback_sheet(id) ON DELETE CASCADE,
  source_prepared_card_id UUID REFERENCES public.prepared_card(id) ON DELETE SET NULL,
  source_db_card_id UUID REFERENCES public.db_card(id) ON DELETE SET NULL,
  excel_product_id TEXT,
  position INT NOT NULL CHECK (position >= 0),
  card_name TEXT NOT NULL CHECK (length(btrim(card_name)) BETWEEN 1 AND 300),
  grade TEXT,
  list_no TEXT,
  rarity TEXT,
  rarity_icon_url TEXT,
  tag TEXT,
  image_url TEXT,
  alt_image_url TEXT,
  image_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (image_status IN ('unchecked', 'ok', 'fallback', 'dead')),
  source_price_high NUMERIC CHECK (source_price_high IS NULL OR source_price_high >= 0),
  source_price_low NUMERIC CHECK (source_price_low IS NULL OR source_price_low >= 0),
  final_price_high NUMERIC CHECK (final_price_high IS NULL OR final_price_high >= 0),
  final_price_low NUMERIC CHECK (final_price_low IS NULL OR final_price_low >= 0),
  price_source TEXT NOT NULL CHECK (price_source IN ('order_list', 'kecak', 'spectre', 'manual')),
  price_source_date DATE NOT NULL,
  override_reason TEXT CHECK (override_reason IS NULL OR length(override_reason) <= 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, position)
);

CREATE UNIQUE INDEX uix_custom_buyback_item_source
  ON public.custom_buyback_item (sheet_id, source_prepared_card_id)
  WHERE source_prepared_card_id IS NOT NULL;

CREATE INDEX idx_custom_buyback_item_sheet_position
  ON public.custom_buyback_item (sheet_id, position);

CREATE TABLE public.custom_buyback_page (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id UUID NOT NULL REFERENCES public.custom_buyback_sheet(id) ON DELETE CASCADE,
  page_index INT NOT NULL CHECK (page_index >= 0),
  layout_template_id UUID NOT NULL REFERENCES public.layout_template(id) ON DELETE RESTRICT,
  item_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'failed')),
  rendered_revision INT NOT NULL CHECK (rendered_revision >= 0),
  image_key TEXT,
  image_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, page_index)
);

CREATE INDEX idx_custom_buyback_page_sheet
  ON public.custom_buyback_page (sheet_id, page_index);

-- Reorder all rows in one transaction. The exact existing item set is required,
-- so cross-sheet IDs, duplicates, missing IDs, and partial writes are rejected.
CREATE OR REPLACE FUNCTION public.reorder_custom_buyback_items(
  p_sheet_id UUID,
  p_store TEXT,
  p_item_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected_count INT;
  v_supplied_count INT;
  v_distinct_count INT;
BEGIN
  PERFORM 1
  FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*)::INT
  INTO v_expected_count
  FROM public.custom_buyback_item
  WHERE sheet_id = p_sheet_id;

  v_supplied_count := coalesce(array_length(p_item_ids, 1), 0);
  SELECT count(DISTINCT value)::INT
  INTO v_distinct_count
  FROM unnest(coalesce(p_item_ids, '{}'::UUID[])) AS supplied(value);

  IF v_supplied_count <> v_expected_count OR v_distinct_count <> v_expected_count THEN
    RAISE EXCEPTION 'item_ids must contain each sheet item exactly once'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(coalesce(p_item_ids, '{}'::UUID[])) AS supplied(value)
    LEFT JOIN public.custom_buyback_item item
      ON item.id = supplied.value AND item.sheet_id = p_sheet_id
    WHERE item.id IS NULL
  ) THEN
    RAISE EXCEPTION 'item_ids contains an item outside the sheet'
      USING ERRCODE = '22023';
  END IF;

  -- Move positions out of the unique range before applying the final ordinality.
  UPDATE public.custom_buyback_item
  SET position = position + v_expected_count + 1,
      updated_at = now()
  WHERE sheet_id = p_sheet_id;

  UPDATE public.custom_buyback_item AS item
  SET position = ordered.ordinality - 1,
      updated_at = now()
  FROM unnest(p_item_ids) WITH ORDINALITY AS ordered(id, ordinality)
  WHERE item.id = ordered.id AND item.sheet_id = p_sheet_id;

  UPDATE public.custom_buyback_sheet
  SET status = 'draft', error_message = NULL, updated_at = now()
  WHERE id = p_sheet_id AND store = p_store;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_custom_buyback_items(UUID, TEXT, UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_custom_buyback_items(UUID, TEXT, UUID[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.bulk_update_custom_buyback_prices(
  p_sheet_id UUID,
  p_store TEXT,
  p_item_ids UUID[],
  p_operation TEXT,
  p_value NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_type TEXT;
  v_count INT;
BEGIN
  SELECT product_type
  INTO v_product_type
  FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_operation NOT IN ('add', 'percent', 'round', 'reset') THEN
    RAISE EXCEPTION 'unsupported bulk price operation' USING ERRCODE = '22023';
  END IF;
  IF p_operation = 'round' AND (p_value IS NULL OR p_value <= 0) THEN
    RAISE EXCEPTION 'round unit must be positive' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT value)::INT
  INTO v_count
  FROM unnest(coalesce(p_item_ids, '{}'::UUID[])) AS supplied(value);
  IF v_count = 0 OR v_count <> coalesce(array_length(p_item_ids, 1), 0) THEN
    RAISE EXCEPTION 'item_ids must be a non-empty unique array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(p_item_ids) AS supplied(value)
    LEFT JOIN public.custom_buyback_item item
      ON item.id = supplied.value AND item.sheet_id = p_sheet_id
    WHERE item.id IS NULL
  ) THEN
    RAISE EXCEPTION 'item_ids contains an item outside the sheet' USING ERRCODE = '22023';
  END IF;

  UPDATE public.custom_buyback_item
  SET final_price_high = CASE p_operation
        WHEN 'reset' THEN source_price_high
        WHEN 'add' THEN greatest(1, round(coalesce(final_price_high, source_price_high) + p_value))
        WHEN 'percent' THEN greatest(1, round(coalesce(final_price_high, source_price_high) * (1 + p_value / 100)))
        WHEN 'round' THEN greatest(1, round(coalesce(final_price_high, source_price_high) / p_value) * p_value)
      END,
      final_price_low = CASE
        WHEN v_product_type = 'box' THEN NULL
        WHEN p_operation = 'reset' THEN source_price_low
        WHEN p_operation = 'add' THEN greatest(1, round(coalesce(final_price_low, source_price_low) + p_value))
        WHEN p_operation = 'percent' THEN greatest(1, round(coalesce(final_price_low, source_price_low) * (1 + p_value / 100)))
        WHEN p_operation = 'round' THEN greatest(1, round(coalesce(final_price_low, source_price_low) / p_value) * p_value)
      END,
      override_reason = CASE WHEN p_operation = 'reset' THEN NULL ELSE '一括価格調整' END,
      updated_at = now()
  WHERE sheet_id = p_sheet_id AND id = ANY(p_item_ids);

  UPDATE public.custom_buyback_sheet
  SET status = 'draft', error_message = NULL, updated_at = now()
  WHERE id = p_sheet_id AND store = p_store;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_update_custom_buyback_prices(UUID, TEXT, UUID[], TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_update_custom_buyback_prices(UUID, TEXT, UUID[], TEXT, NUMERIC)
  TO service_role;

-- Clone the editable snapshot and every item in one transaction. Generated pages
-- are intentionally not copied because the new sheet gets its own render revision.
CREATE OR REPLACE FUNCTION public.clone_custom_buyback_sheet(
  p_sheet_id UUID,
  p_store TEXT,
  p_name TEXT,
  p_created_by TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source public.custom_buyback_sheet%ROWTYPE;
  v_new_sheet_id UUID;
BEGIN
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'sheet name must contain 1 to 120 characters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_source
  FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.custom_buyback_sheet (
    store, name, franchise, product_type, kind,
    price_snapshot_run_id, price_business_date, display_date, created_by
  ) VALUES (
    p_store, btrim(p_name), v_source.franchise, v_source.product_type, v_source.kind,
    v_source.price_snapshot_run_id, v_source.price_business_date, v_source.display_date,
    nullif(btrim(p_created_by), '')
  ) RETURNING id INTO v_new_sheet_id;

  INSERT INTO public.custom_buyback_item (
    sheet_id, source_prepared_card_id, source_db_card_id, excel_product_id,
    position, card_name, grade, list_no, rarity, rarity_icon_url, tag,
    image_url, alt_image_url, image_status,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason
  )
  SELECT
    v_new_sheet_id, source_prepared_card_id, source_db_card_id, excel_product_id,
    position, card_name, grade, list_no, rarity, rarity_icon_url, tag,
    image_url, alt_image_url, image_status,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason
  FROM public.custom_buyback_item
  WHERE sheet_id = p_sheet_id
  ORDER BY position;

  RETURN v_new_sheet_id;
END;
$$;

REVOKE ALL ON FUNCTION public.clone_custom_buyback_sheet(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clone_custom_buyback_sheet(UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- The API supplies an exact old-item -> current-prepared-card mapping. This
-- function revalidates the whole mapping and applies it atomically, so a missing,
-- duplicated, wrong-store, wrong-title, wrong-kind, or wrong-date card rolls the
-- entire refresh back.
CREATE OR REPLACE FUNCTION public.refresh_custom_buyback_prices(
  p_sheet_id UUID,
  p_store TEXT,
  p_run_id UUID,
  p_business_date DATE,
  p_item_ids UUID[],
  p_prepared_card_ids UUID[],
  p_preserve_overrides BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet public.custom_buyback_sheet%ROWTYPE;
  v_expected_count INT;
  v_supplied_count INT;
  v_valid_count INT;
  v_distinct_cards INT;
BEGIN
  SELECT * INTO v_sheet
  FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sheet.status = 'rendering' THEN
    RAISE EXCEPTION 'cannot refresh a rendering sheet' USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.run AS run
  JOIN public.order_list_import AS source_import ON source_import.id = run.order_list_import_id
  WHERE run.id = p_run_id
    AND run.store = p_store
    AND run.status = 'completed'
    AND source_import.store = p_store
    AND source_import.status = 'applied'
    AND source_import.structural_valid = TRUE
    AND source_import.persistence_complete = TRUE
    AND source_import.business_date = p_business_date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target price snapshot is not a completed applied import' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::INT INTO v_expected_count
  FROM public.custom_buyback_item
  WHERE sheet_id = p_sheet_id;
  v_supplied_count := coalesce(array_length(p_item_ids, 1), 0);
  IF v_supplied_count <> v_expected_count
     OR v_supplied_count <> coalesce(array_length(p_prepared_card_ids, 1), 0) THEN
    RAISE EXCEPTION 'refresh mapping must contain every item exactly once' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::INT, count(DISTINCT card.id)::INT
  INTO v_valid_count, v_distinct_cards
  FROM unnest(p_item_ids, p_prepared_card_ids) AS supplied(item_id, prepared_card_id)
  JOIN public.custom_buyback_item AS item
    ON item.id = supplied.item_id AND item.sheet_id = p_sheet_id
  JOIN public.prepared_card AS card
    ON card.id = supplied.prepared_card_id
   AND card.run_id = p_run_id
   AND card.franchise = v_sheet.franchise
   AND card.price_source_date = p_business_date
   AND card.price_high > 0
   AND (
     (v_sheet.product_type = 'box' AND card.tag = 'BOX')
     OR
     (v_sheet.product_type = 'psa'
       AND card.tag IS DISTINCT FROM 'BOX'
       AND regexp_replace(upper(btrim(coalesce(card.grade, ''))), '\s+', ' ', 'g') LIKE 'PSA%'
       AND card.price_low > 0)
   );
  IF v_valid_count <> v_expected_count OR v_distinct_cards <> v_expected_count THEN
    RAISE EXCEPTION 'refresh mapping contains missing, duplicate, or incompatible cards' USING ERRCODE = '22023';
  END IF;

  WITH supplied AS (
    SELECT * FROM unnest(p_item_ids, p_prepared_card_ids) AS pair(item_id, prepared_card_id)
  )
  UPDATE public.custom_buyback_item AS item
  SET source_prepared_card_id = card.id,
      source_db_card_id = card.db_card_id,
      excel_product_id = card.excel_product_id,
      card_name = card.card_name,
      grade = card.grade,
      list_no = card.list_no,
      rarity = card.rarity,
      rarity_icon_url = card.rarity_icon_url,
      tag = card.tag,
      image_url = card.image_url,
      alt_image_url = card.alt_image_url,
      image_status = card.image_status,
      final_price_high = CASE
        WHEN p_preserve_overrides AND (
          item.override_reason IS NOT NULL
          OR item.final_price_high IS DISTINCT FROM item.source_price_high
          OR item.final_price_low IS DISTINCT FROM item.source_price_low
        ) THEN item.final_price_high
        ELSE card.price_high
      END,
      final_price_low = CASE
        WHEN v_sheet.product_type = 'box' THEN NULL
        WHEN p_preserve_overrides AND (
          item.override_reason IS NOT NULL
          OR item.final_price_high IS DISTINCT FROM item.source_price_high
          OR item.final_price_low IS DISTINCT FROM item.source_price_low
        ) THEN item.final_price_low
        ELSE card.price_low
      END,
      source_price_high = card.price_high,
      source_price_low = CASE WHEN v_sheet.product_type = 'box' THEN NULL ELSE card.price_low END,
      price_source = card.price_source,
      price_source_date = card.price_source_date,
      override_reason = CASE
        WHEN p_preserve_overrides AND (
          item.override_reason IS NOT NULL
          OR item.final_price_high IS DISTINCT FROM item.source_price_high
          OR item.final_price_low IS DISTINCT FROM item.source_price_low
        ) THEN coalesce(item.override_reason, '価格更新前の手修正を維持')
        ELSE NULL
      END,
      updated_at = now()
  FROM supplied
  JOIN public.prepared_card AS card ON card.id = supplied.prepared_card_id
  WHERE item.id = supplied.item_id AND item.sheet_id = p_sheet_id;

  UPDATE public.custom_buyback_sheet
  SET price_snapshot_run_id = p_run_id,
      price_business_date = p_business_date,
      status = 'draft',
      error_message = NULL,
      updated_at = now()
  WHERE id = p_sheet_id AND store = p_store;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_custom_buyback_prices(UUID, TEXT, UUID, DATE, UUID[], UUID[], BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_custom_buyback_prices(UUID, TEXT, UUID, DATE, UUID[], UUID[], BOOLEAN)
  TO service_role;

-- Serialize every item mutation with its parent sheet. If a render claimed the
-- sheet first, the mutation is rejected. If the mutation claimed it first, the
-- renderer waits and then sees the newly-drafted state.
CREATE OR REPLACE FUNCTION public.guard_custom_buyback_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.sheet_id ELSE NEW.sheet_id END;
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM public.custom_buyback_sheet
  WHERE id = v_sheet_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'rendering' THEN
    RAISE EXCEPTION 'cannot mutate items while rendering' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_custom_buyback_sheet_draft()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.sheet_id ELSE NEW.sheet_id END;
BEGIN
  UPDATE public.custom_buyback_sheet
  SET status = 'draft', error_message = NULL, updated_at = now()
  WHERE id = v_sheet_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_custom_buyback_item_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.custom_buyback_item
FOR EACH ROW EXECUTE FUNCTION public.guard_custom_buyback_item_mutation();

CREATE TRIGGER trg_custom_buyback_item_mark_draft
AFTER INSERT OR UPDATE OR DELETE ON public.custom_buyback_item
FOR EACH ROW EXECUTE FUNCTION public.mark_custom_buyback_sheet_draft();

REVOKE ALL ON FUNCTION public.guard_custom_buyback_item_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_custom_buyback_sheet_draft() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_custom_buyback_items(
  p_sheet_id UUID,
  p_store TEXT,
  p_prepared_card_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet public.custom_buyback_sheet%ROWTYPE;
  v_existing_count INT;
  v_supplied_count INT;
  v_valid_count INT;
  v_next_position INT;
BEGIN
  SELECT * INTO v_sheet FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002'; END IF;
  IF v_sheet.status = 'rendering' THEN RAISE EXCEPTION 'cannot add items while rendering' USING ERRCODE = '55000'; END IF;

  v_supplied_count := coalesce(array_length(p_prepared_card_ids, 1), 0);
  IF v_supplied_count NOT BETWEEN 1 AND 100
     OR (SELECT count(DISTINCT value) FROM unnest(coalesce(p_prepared_card_ids, '{}'::UUID[])) AS supplied(value)) <> v_supplied_count THEN
    RAISE EXCEPTION 'prepared card IDs must be a unique array of 1 to 100 items' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::INT, coalesce(max(position), -1) + 1 INTO v_existing_count, v_next_position
  FROM public.custom_buyback_item WHERE sheet_id = p_sheet_id;
  IF v_existing_count + v_supplied_count > 400 THEN RAISE EXCEPTION 'custom buyback sheet item limit exceeded' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.custom_buyback_item WHERE sheet_id = p_sheet_id AND source_prepared_card_id = ANY(p_prepared_card_ids)) THEN
    RAISE EXCEPTION 'prepared card already exists in sheet' USING ERRCODE = '23505';
  END IF;

  SELECT count(*)::INT INTO v_valid_count
  FROM public.prepared_card AS card
  WHERE card.id = ANY(p_prepared_card_ids)
    AND card.run_id = v_sheet.price_snapshot_run_id
    AND card.franchise = v_sheet.franchise
    AND card.price_source_date = v_sheet.price_business_date
    AND card.price_high > 0
    AND ((v_sheet.product_type = 'box' AND card.tag = 'BOX') OR
      (v_sheet.product_type = 'psa' AND card.tag IS DISTINCT FROM 'BOX'
       AND regexp_replace(upper(btrim(coalesce(card.grade, ''))), '\s+', ' ', 'g') LIKE 'PSA%'
       AND card.price_low > 0));
  IF v_valid_count <> v_supplied_count THEN
    RAISE EXCEPTION 'prepared cards do not match the sheet snapshot or product type' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.custom_buyback_item (
    sheet_id, source_prepared_card_id, source_db_card_id, excel_product_id, position,
    card_name, grade, list_no, rarity, rarity_icon_url, tag, image_url, alt_image_url, image_status,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason
  )
  SELECT p_sheet_id, card.id, card.db_card_id, card.excel_product_id,
    v_next_position + supplied.ordinality - 1, card.card_name, card.grade, card.list_no,
    card.rarity, card.rarity_icon_url, card.tag, card.image_url, card.alt_image_url, card.image_status,
    card.price_high, CASE WHEN v_sheet.product_type = 'box' THEN NULL ELSE card.price_low END,
    card.price_high, CASE WHEN v_sheet.product_type = 'box' THEN NULL ELSE card.price_low END,
    card.price_source, card.price_source_date, NULL
  FROM unnest(p_prepared_card_ids) WITH ORDINALITY AS supplied(id, ordinality)
  JOIN public.prepared_card AS card ON card.id = supplied.id
  ORDER BY supplied.ordinality;
END;
$$;

REVOKE ALL ON FUNCTION public.add_custom_buyback_items(UUID, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_custom_buyback_items(UUID, TEXT, UUID[]) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_custom_buyback_item(p_sheet_id UUID, p_store TEXT, p_item_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  PERFORM 1 FROM public.custom_buyback_sheet WHERE id = p_sheet_id AND store = p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002'; END IF;
  DELETE FROM public.custom_buyback_item WHERE id = p_item_id AND sheet_id = p_sheet_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom buyback item not found' USING ERRCODE = 'P0002'; END IF;
  SELECT count(*)::INT INTO v_count FROM public.custom_buyback_item WHERE sheet_id = p_sheet_id;
  UPDATE public.custom_buyback_item SET position = position + v_count + 1 WHERE sheet_id = p_sheet_id;
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS new_position
    FROM public.custom_buyback_item WHERE sheet_id = p_sheet_id
  )
  UPDATE public.custom_buyback_item AS item SET position = ordered.new_position, updated_at = now()
  FROM ordered WHERE item.id = ordered.id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_custom_buyback_item(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_custom_buyback_item(UUID, TEXT, UUID) TO service_role;

ALTER TABLE public.custom_buyback_sheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_buyback_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_buyback_page ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.custom_buyback_sheet,
  public.custom_buyback_item,
  public.custom_buyback_page
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.custom_buyback_sheet,
  public.custom_buyback_item,
  public.custom_buyback_page
TO service_role;
