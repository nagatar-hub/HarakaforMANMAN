BEGIN;

ALTER TABLE public.kaitori_checker_product_snapshot
  ADD CONSTRAINT chk_kaitori_checker_product_id_js_safe
    CHECK (source_product_id <= 9007199254740991);
ALTER TABLE public.kaitori_checker_offer_snapshot
  ADD CONSTRAINT chk_kaitori_checker_offer_product_id_js_safe
    CHECK (source_product_id <= 9007199254740991);
ALTER TABLE public.kaitori_checker_ranking_snapshot
  ADD CONSTRAINT chk_kaitori_checker_ranking_product_id_js_safe
    CHECK (source_product_id IS NULL OR source_product_id <= 9007199254740991);
ALTER TABLE public.custom_buyback_item
  ADD CONSTRAINT chk_custom_buyback_kaitori_product_id_js_safe
    CHECK (source_kaitori_product_id IS NULL OR source_kaitori_product_id <= 9007199254740991);

ALTER TABLE public.custom_buyback_sheet
  ADD COLUMN kaitori_checker_source_store TEXT
    CHECK (kaitori_checker_source_store IS NULL OR length(btrim(kaitori_checker_source_store)) BETWEEN 1 AND 100);

UPDATE public.custom_buyback_sheet
SET kaitori_checker_source_store = store
WHERE catalog_source = 'kaitori_checker';

ALTER TABLE public.custom_buyback_sheet
  DROP CONSTRAINT fk_custom_buyback_sheet_kaitori_checker_run,
  DROP CONSTRAINT chk_custom_buyback_sheet_exactly_one_catalog;

ALTER TABLE public.custom_buyback_sheet
  ADD CONSTRAINT fk_custom_buyback_sheet_kaitori_checker_run
    FOREIGN KEY (kaitori_checker_source_store, kaitori_checker_run_id)
    REFERENCES public.kaitori_checker_sync_run (store, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_custom_buyback_sheet_exactly_one_catalog
    CHECK (
      (catalog_source = 'prepared_card'
        AND price_snapshot_run_id IS NOT NULL
        AND kaitori_checker_run_id IS NULL
        AND kaitori_checker_source_store IS NULL)
      OR
      (catalog_source = 'kaitori_checker'
        AND price_snapshot_run_id IS NULL
        AND kaitori_checker_run_id IS NOT NULL
        AND kaitori_checker_source_store IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION public.default_custom_buyback_kaitori_source_store()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.catalog_source = 'kaitori_checker' AND NEW.kaitori_checker_source_store IS NULL THEN
    NEW.kaitori_checker_source_store := NEW.store;
  ELSIF NEW.catalog_source = 'prepared_card' THEN
    NEW.kaitori_checker_source_store := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_custom_buyback_kaitori_source_store
BEFORE INSERT OR UPDATE OF store, catalog_source, kaitori_checker_source_store
ON public.custom_buyback_sheet
FOR EACH ROW EXECUTE FUNCTION public.default_custom_buyback_kaitori_source_store();

CREATE OR REPLACE FUNCTION public.add_custom_buyback_kaitori_items(
  p_sheet_id UUID,
  p_store TEXT,
  p_source_product_ids BIGINT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet public.custom_buyback_sheet%ROWTYPE;
  v_category TEXT;
  v_condition_id BIGINT;
  v_existing_count INT;
  v_supplied_count INT;
  v_valid_count INT;
  v_next_position INT;
BEGIN
  SELECT * INTO v_sheet
  FROM public.custom_buyback_sheet
  WHERE id = p_sheet_id AND store = p_store
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'custom buyback sheet not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sheet.status = 'rendering' THEN
    RAISE EXCEPTION 'cannot add items while rendering' USING ERRCODE = '55000';
  END IF;
  IF v_sheet.catalog_source <> 'kaitori_checker' THEN
    RAISE EXCEPTION 'sheet does not use the kaitori checker catalog' USING ERRCODE = '22023';
  END IF;

  v_category := CASE v_sheet.franchise
    WHEN 'Pokemon' THEN 'pokemon'
    WHEN 'ONE PIECE' THEN 'one_piece'
    ELSE NULL
  END;
  v_condition_id := CASE v_sheet.product_type WHEN 'psa' THEN 1 WHEN 'box' THEN 2 END;
  IF v_category IS NULL OR v_condition_id IS NULL THEN
    RAISE EXCEPTION 'unsupported kaitori checker category or product type' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.kaitori_checker_sync_run
  WHERE id = v_sheet.kaitori_checker_run_id
    AND store = v_sheet.kaitori_checker_source_store
    AND status = 'applied';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target kaitori checker run is not applied for store' USING ERRCODE = '22023';
  END IF;

  v_supplied_count := coalesce(array_length(p_source_product_ids, 1), 0);
  IF v_supplied_count NOT BETWEEN 1 AND 100
     OR (SELECT count(DISTINCT value)
         FROM unnest(coalesce(p_source_product_ids, '{}'::BIGINT[])) AS supplied(value))
        <> v_supplied_count THEN
    RAISE EXCEPTION 'source product IDs must be a unique array of 1 to 100 items'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::INT, coalesce(max(position), -1) + 1
  INTO v_existing_count, v_next_position
  FROM public.custom_buyback_item
  WHERE sheet_id = p_sheet_id;
  IF v_existing_count + v_supplied_count > 400 THEN
    RAISE EXCEPTION 'custom buyback sheet item limit exceeded' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.custom_buyback_item
    WHERE sheet_id = p_sheet_id
      AND source_kaitori_product_id = ANY(p_source_product_ids)
  ) THEN
    RAISE EXCEPTION 'kaitori checker product already exists in sheet' USING ERRCODE = '23505';
  END IF;

  SELECT count(*)::INT INTO v_valid_count
  FROM public.kaitori_checker_custom_buyback_catalog AS catalog
  WHERE catalog.run_id = v_sheet.kaitori_checker_run_id
    AND catalog.store = v_sheet.kaitori_checker_source_store
    AND catalog.category = v_category
    AND catalog.condition_id = v_condition_id
    AND catalog.source_product_id = ANY(p_source_product_ids);
  IF v_valid_count <> v_supplied_count THEN
    RAISE EXCEPTION 'products do not match the sheet run, category, or product type'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.custom_buyback_item (
    sheet_id, position, card_name, grade, list_no, rarity, tag, image_url,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason,
    source_kaitori_product_id, source_kaitori_condition_id,
    source_kaitori_shop_id, source_kaitori_edition_id, source_shop_name, demand
  )
  SELECT
    p_sheet_id,
    v_next_position + supplied.ordinality - 1,
    catalog.name,
    catalog.condition_name,
    catalog.model_number,
    catalog.rarity,
    CASE WHEN v_sheet.product_type = 'box' THEN 'BOX' END,
    catalog.image_url,
    catalog.buy_price,
    NULL,
    catalog.buy_price,
    NULL,
    'kaitori_checker',
    v_sheet.price_business_date,
    NULL,
    catalog.source_product_id,
    catalog.condition_id,
    catalog.shop_id,
    catalog.edition_id,
    catalog.shop_name,
    1
  FROM unnest(p_source_product_ids) WITH ORDINALITY AS supplied(id, ordinality)
  JOIN public.kaitori_checker_custom_buyback_catalog AS catalog
    ON catalog.run_id = v_sheet.kaitori_checker_run_id
   AND catalog.store = v_sheet.kaitori_checker_source_store
   AND catalog.category = v_category
   AND catalog.condition_id = v_condition_id
   AND catalog.source_product_id = supplied.id
  ORDER BY supplied.ordinality;
END;
$$;

REVOKE ALL ON FUNCTION public.add_custom_buyback_kaitori_items(UUID, TEXT, BIGINT[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_custom_buyback_kaitori_items(UUID, TEXT, BIGINT[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_custom_buyback_kaitori_prices(
  p_sheet_id UUID,
  p_store TEXT,
  p_run_id UUID,
  p_business_date DATE,
  p_preserve_overrides BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sheet public.custom_buyback_sheet%ROWTYPE;
  v_category TEXT;
  v_condition_id BIGINT;
  v_expected_count INT;
  v_valid_count INT;
  v_distinct_products INT;
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
  IF v_sheet.catalog_source <> 'kaitori_checker' OR p_business_date IS NULL THEN
    RAISE EXCEPTION 'invalid kaitori checker refresh target' USING ERRCODE = '22023';
  END IF;

  v_category := CASE v_sheet.franchise
    WHEN 'Pokemon' THEN 'pokemon'
    WHEN 'ONE PIECE' THEN 'one_piece'
    ELSE NULL
  END;
  v_condition_id := CASE v_sheet.product_type WHEN 'psa' THEN 1 WHEN 'box' THEN 2 END;
  IF v_category IS NULL OR v_condition_id IS NULL THEN
    RAISE EXCEPTION 'unsupported kaitori checker category or product type' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.kaitori_checker_sync_run
  WHERE id = p_run_id AND store = v_sheet.kaitori_checker_source_store AND status = 'applied';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target kaitori checker run is not applied for store' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::INT, count(DISTINCT source_kaitori_product_id)::INT
  INTO v_expected_count, v_distinct_products
  FROM public.custom_buyback_item
  WHERE sheet_id = p_sheet_id;
  IF v_expected_count NOT BETWEEN 1 AND 400
     OR v_distinct_products <> v_expected_count THEN
    RAISE EXCEPTION 'sheet must contain 1 to 400 unique kaitori checker products'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::INT INTO v_valid_count
  FROM public.custom_buyback_item AS item
  JOIN public.kaitori_checker_custom_buyback_catalog AS catalog
    ON catalog.run_id = p_run_id
   AND catalog.store = v_sheet.kaitori_checker_source_store
   AND catalog.category = v_category
   AND catalog.condition_id = v_condition_id
   AND catalog.source_product_id = item.source_kaitori_product_id
  WHERE item.sheet_id = p_sheet_id;
  IF v_valid_count <> v_expected_count THEN
    RAISE EXCEPTION 'refresh contains missing, duplicate, or incompatible products'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.custom_buyback_item AS item
  SET card_name = catalog.name,
      grade = catalog.condition_name,
      list_no = catalog.model_number,
      rarity = catalog.rarity,
      tag = CASE WHEN v_sheet.product_type = 'box' THEN 'BOX' END,
      image_url = catalog.image_url,
      final_price_high = CASE
        WHEN p_preserve_overrides AND (
          item.override_reason IS NOT NULL
          OR item.final_price_high IS DISTINCT FROM item.source_price_high
        ) THEN item.final_price_high
        ELSE catalog.buy_price
      END,
      final_price_low = NULL,
      source_price_high = catalog.buy_price,
      source_price_low = NULL,
      price_source = 'kaitori_checker',
      price_source_date = p_business_date,
      override_reason = CASE
        WHEN p_preserve_overrides AND (
          item.override_reason IS NOT NULL
          OR item.final_price_high IS DISTINCT FROM item.source_price_high
        ) THEN coalesce(item.override_reason, '価格更新前の手修正を維持')
        ELSE NULL
      END,
      source_kaitori_condition_id = catalog.condition_id,
      source_kaitori_shop_id = catalog.shop_id,
      source_kaitori_edition_id = catalog.edition_id,
      source_shop_name = catalog.shop_name,
      updated_at = now()
  FROM public.kaitori_checker_custom_buyback_catalog AS catalog
  WHERE item.sheet_id = p_sheet_id
    AND catalog.run_id = p_run_id
    AND catalog.store = v_sheet.kaitori_checker_source_store
    AND catalog.category = v_category
    AND catalog.condition_id = v_condition_id
    AND catalog.source_product_id = item.source_kaitori_product_id;

  UPDATE public.custom_buyback_sheet
  SET kaitori_checker_run_id = p_run_id,
      price_business_date = p_business_date,
      status = 'draft',
      error_message = NULL,
      updated_at = now()
  WHERE id = p_sheet_id AND store = p_store;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_custom_buyback_kaitori_prices(
  UUID, TEXT, UUID, DATE, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_custom_buyback_kaitori_prices(
  UUID, TEXT, UUID, DATE, BOOLEAN
) TO service_role;

-- Keep clone behavior backward-compatible while carrying either catalog source.
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
    price_snapshot_run_id, kaitori_checker_run_id, kaitori_checker_source_store, catalog_source,
    price_business_date, display_date, created_by
  ) VALUES (
    p_store, btrim(p_name), v_source.franchise, v_source.product_type, v_source.kind,
    v_source.price_snapshot_run_id, v_source.kaitori_checker_run_id, v_source.kaitori_checker_source_store, v_source.catalog_source,
    v_source.price_business_date, v_source.display_date, nullif(btrim(p_created_by), '')
  ) RETURNING id INTO v_new_sheet_id;

  INSERT INTO public.custom_buyback_item (
    sheet_id, source_prepared_card_id, source_db_card_id, excel_product_id,
    position, card_name, grade, list_no, rarity, rarity_icon_url, tag,
    image_url, alt_image_url, image_status,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason,
    source_kaitori_product_id, source_kaitori_condition_id,
    source_kaitori_shop_id, source_kaitori_edition_id, source_shop_name, demand
  )
  SELECT
    v_new_sheet_id, source_prepared_card_id, source_db_card_id, excel_product_id,
    position, card_name, grade, list_no, rarity, rarity_icon_url, tag,
    image_url, alt_image_url, image_status,
    source_price_high, source_price_low, final_price_high, final_price_low,
    price_source, price_source_date, override_reason,
    source_kaitori_product_id, source_kaitori_condition_id,
    source_kaitori_shop_id, source_kaitori_edition_id, source_shop_name, demand
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

NOTIFY pgrst, 'reload schema';
COMMIT;
