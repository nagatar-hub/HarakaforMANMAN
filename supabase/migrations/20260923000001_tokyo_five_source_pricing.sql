BEGIN;

ALTER TABLE public.tokyo_buyback_product
  ADD COLUMN price_low NUMERIC CHECK(price_low IS NULL OR (price_low >= 0 AND price_low <= price_high AND price_low = trunc(price_low))),
  ADD COLUMN selected_high_source TEXT CHECK(selected_high_source IS NULL OR selected_high_source IN ('kecak','blue_rocket','toreca_bank','avirile','shinsoku')),
  ADD COLUMN selected_low_source TEXT CHECK(selected_low_source IS NULL OR selected_low_source IN ('kecak','blue_rocket','toreca_bank','avirile','shinsoku')),
  ADD CONSTRAINT chk_tokyo_selected_prices CHECK (
    (price_low IS NULL AND selected_high_source IS NULL AND selected_low_source IS NULL)
    OR (price_low IS NOT NULL AND selected_high_source IS NOT NULL AND selected_low_source IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.publish_tokyo_buyback_snapshot(p_snapshot JSONB, p_products JSONB, p_run_id UUID DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_snapshot public.tokyo_buyback_snapshot%ROWTYPE;
  v_latest UUID;
BEGIN
  v_snapshot := jsonb_populate_record(NULL::public.tokyo_buyback_snapshot, p_snapshot);
  IF v_snapshot.store IS DISTINCT FROM 'manman-akihabara' THEN
    RAISE EXCEPTION 'Tokyo store required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tokyo-buyback-publish'));
  IF p_run_id IS NOT NULL THEN
    PERFORM 1 FROM public.order_list_import WHERE id=v_snapshot.order_list_import_id FOR UPDATE;
    PERFORM 1 FROM public.run r JOIN public.order_list_import i ON i.id=r.order_list_import_id
      WHERE r.id=p_run_id AND r.store='manman-akihabara' AND i.store=r.store
        AND i.id=v_snapshot.order_list_import_id AND i.status='processing' AND r.status='running'
        AND r.tokyo_snapshot_id IS NULL AND i.heartbeat_at >= clock_timestamp()-interval '5 minutes'
        AND r.order_list_sync_request_id IS NOT DISTINCT FROM i.order_list_sync_request_id
        AND r.order_list_sync_request_fingerprint IS NOT DISTINCT FROM i.order_list_sync_request_fingerprint
      FOR UPDATE OF r;
    IF NOT FOUND THEN RAISE EXCEPTION 'active Tokyo sync lease required' USING ERRCODE='22023'; END IF;
  END IF;
  SELECT id INTO v_latest FROM public.order_list_import
    WHERE store = v_snapshot.store ORDER BY business_date DESC, created_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_snapshot.order_list_import_id OR NOT EXISTS (
    SELECT 1 FROM public.order_list_import WHERE id = v_latest
      AND status = CASE WHEN p_run_id IS NULL THEN 'applied' ELSE 'processing' END AND structural_valid AND persistence_complete
  ) THEN RAISE EXCEPTION 'latest complete Tokyo order list required' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_latest FROM public.kaitori_checker_sync_run
    WHERE store = v_snapshot.checker_source_store AND status = 'applied' ORDER BY created_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_snapshot.checker_run_id OR NOT EXISTS (
    SELECT 1 FROM public.kaitori_checker_sync_run WHERE id=v_latest AND status='applied'
      AND completed_at >= v_snapshot.fetched_at - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'latest applied checker run required' USING ERRCODE = '22023';
  END IF;
  IF v_snapshot.fetched_at > clock_timestamp() + interval '5 minutes'
    OR v_snapshot.business_date IS DISTINCT FROM (v_snapshot.fetched_at AT TIME ZONE 'Asia/Tokyo')::DATE
    OR EXISTS (SELECT 1 FROM public.tokyo_buyback_snapshot WHERE fetched_at >= v_snapshot.fetched_at) THEN
    RAISE EXCEPTION 'snapshot is stale or has invalid date' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_products) IS DISTINCT FROM 'array' OR jsonb_array_length(p_products) < 1 THEN
    RAISE EXCEPTION 'complete nonempty products required' USING ERRCODE = '22023';
  END IF;
  IF p_snapshot #>> '{report,pricing_version}' = '2' AND EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_products) AS p(
      price_low NUMERIC, selected_high_source TEXT, selected_low_source TEXT
    ) WHERE p.price_low IS NULL OR p.selected_high_source IS NULL OR p.selected_low_source IS NULL
  ) THEN
    RAISE EXCEPTION 'complete Tokyo comparison prices required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.tokyo_buyback_snapshot SELECT v_snapshot.*;
  INSERT INTO public.tokyo_buyback_product (
    snapshot_id,id,franchise,product_type,name,model_number,image_url,source_price,price_high,origins,
    price_low,selected_high_source,selected_low_source
  )
  SELECT v_snapshot.id, p.id, p.franchise, p.product_type, p.name, p.model_number,
    p.image_url, p.source_price, p.price_high, p.origins, p.price_low, p.selected_high_source, p.selected_low_source
  FROM jsonb_to_recordset(p_products) AS p(
    id TEXT, franchise TEXT, product_type TEXT, name TEXT, model_number TEXT, image_url TEXT,
    source_price NUMERIC, price_high NUMERIC, origins JSONB, price_low NUMERIC,
    selected_high_source TEXT, selected_low_source TEXT
  );
  IF p_run_id IS NOT NULL THEN
    UPDATE public.run SET tokyo_snapshot_id=v_snapshot.id WHERE id=p_run_id;
  END IF;
  RETURN v_snapshot.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_prepared_shinsoku_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.source_shinsoku_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.run r JOIN public.tokyo_buyback_product p ON p.snapshot_id=r.tokyo_snapshot_id
      JOIN public.tokyo_buyback_snapshot s ON s.id=p.snapshot_id
      CROSS JOIN LATERAL (
        SELECT p.source_price::DOUBLE PRECISION * (1::DOUBLE PRECISION -
          (s.settings->'box_discount_rates'->p.franchise->>'no_shrink')::DOUBLE PRECISION) AS raw_low
      ) legacy_lower
    WHERE r.id=NEW.run_id AND r.store='manman-akihabara' AND p.id=NEW.source_shinsoku_id
      AND p.franchise=NEW.franchise AND p.name=NEW.card_name AND p.model_number IS NOT DISTINCT FROM NEW.list_no
      AND NEW.price_high=p.price_high
      AND NEW.price_low=COALESCE(p.price_low, CASE p.product_type WHEN 'box' THEN
        CASE WHEN jsonb_typeof(s.settings->'box_discount_rates'->p.franchise->'no_shrink')='number'
          AND (s.settings->'box_discount_rates'->p.franchise->>'no_shrink')::DOUBLE PRECISION BETWEEN 0 AND 1 THEN
          LEAST(p.price_high, CASE WHEN legacy_lower.raw_low <= 0 THEN 0 ELSE
            FLOOR(legacy_lower.raw_low / CASE
              WHEN legacy_lower.raw_low < 10000 THEN 100
              WHEN legacy_lower.raw_low < 100000 THEN 1000
              WHEN legacy_lower.raw_low < 1000000 THEN 10000 ELSE 100000 END)
            * CASE WHEN legacy_lower.raw_low < 10000 THEN 100
              WHEN legacy_lower.raw_low < 100000 THEN 1000
              WHEN legacy_lower.raw_low < 1000000 THEN 10000 ELSE 100000 END
          END)
        ELSE NULL END
        ELSE p.price_high END)
      AND CASE p.product_type WHEN 'box' THEN NEW.tag='BOX'
        ELSE NULLIF(BTRIM(NEW.tag),'') IS NOT NULL AND NEW.tag <> 'BOX' END
      AND NEW.grade=CASE p.product_type WHEN 'box' THEN '未開封BOX' ELSE 'PSA10' END
  ) THEN RAISE EXCEPTION 'prepared product must match its Tokyo snapshot' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_custom_buyback_shinsoku_items(p_sheet_id UUID, p_store TEXT, p_product_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.custom_buyback_sheet%ROWTYPE;
  v_count INT;
  v_position INT;
  v_supplied INT := coalesce(cardinality(p_product_ids),0);
BEGIN
  SELECT * INTO s FROM public.custom_buyback_sheet WHERE id=p_sheet_id AND store=p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sheet not found' USING ERRCODE='P0002'; END IF;
  IF p_store <> 'manman-akihabara' OR s.catalog_source <> 'shinsoku' OR s.status='rendering' THEN
    RAISE EXCEPTION 'invalid Tokyo sheet' USING ERRCODE='22023'; END IF;
  IF v_supplied NOT BETWEEN 1 AND 100 OR (SELECT count(DISTINCT id) FROM unnest(p_product_ids) t(id)) <> v_supplied THEN
    RAISE EXCEPTION 'unique product IDs required' USING ERRCODE='22023'; END IF;
  SELECT count(*),coalesce(max(position),-1)+1 INTO v_count,v_position FROM public.custom_buyback_item WHERE sheet_id=p_sheet_id;
  IF v_count + v_supplied > 400 THEN RAISE EXCEPTION 'item limit exceeded' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.tokyo_buyback_product WHERE snapshot_id=s.tokyo_snapshot_id
    AND franchise=s.franchise AND product_type=s.product_type AND id=ANY(p_product_ids)) <> v_supplied THEN
    RAISE EXCEPTION 'incompatible snapshot products' USING ERRCODE='22023'; END IF;
  INSERT INTO public.custom_buyback_item(sheet_id,position,card_name,grade,list_no,tag,image_url,image_status,
    source_price_high,final_price_high,price_source,price_source_date,source_shinsoku_id,source_shop_name)
  SELECT p_sheet_id,v_position+t.ordinality-1,p.name,CASE s.product_type WHEN 'psa' THEN 'PSA10' ELSE '未開封BOX' END,
    p.model_number,CASE s.product_type WHEN 'box' THEN 'BOX' END,p.image_url,
    CASE WHEN p.image_url IS NULL THEN 'unchecked' ELSE 'ok' END,
    p.price_high,p.price_high,'shinsoku',s.price_business_date,p.id,
    CASE coalesce(p.selected_high_source,'shinsoku')
      WHEN 'kecak' THEN 'KECAK' WHEN 'blue_rocket' THEN 'Blue Rocket' WHEN 'toreca_bank' THEN 'トレカバンク'
      WHEN 'avirile' THEN 'アヴィリール' ELSE 'シンソク郵送買取' END
  FROM unnest(p_product_ids) WITH ORDINALITY t(id,ordinality)
  JOIN public.tokyo_buyback_product p ON p.snapshot_id=s.tokyo_snapshot_id AND p.id=t.id ORDER BY t.ordinality;
  UPDATE public.custom_buyback_sheet SET status='draft',error_message=NULL,updated_at=now() WHERE id=p_sheet_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_custom_buyback_shinsoku_prices(p_sheet_id UUID,p_store TEXT,p_snapshot_id UUID,p_preserve_overrides BOOLEAN DEFAULT TRUE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.custom_buyback_sheet%ROWTYPE;
  v_date DATE;
  v_count INT;
BEGIN
  SELECT * INTO s FROM public.custom_buyback_sheet WHERE id=p_sheet_id AND store=p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sheet not found' USING ERRCODE='P0002'; END IF;
  IF p_store <> 'manman-akihabara' OR s.catalog_source <> 'shinsoku' OR s.status='rendering' THEN
    RAISE EXCEPTION 'invalid Tokyo sheet' USING ERRCODE='22023'; END IF;
  SELECT business_date INTO v_date FROM public.tokyo_buyback_snapshot WHERE id=p_snapshot_id AND store=p_store;
  IF NOT FOUND OR v_date <> (now() AT TIME ZONE 'Asia/Tokyo')::DATE THEN
    RAISE EXCEPTION 'current snapshot required' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM public.custom_buyback_item WHERE sheet_id=p_sheet_id;
  IF v_count NOT BETWEEN 1 AND 400 OR v_count <> (
    SELECT count(*) FROM public.custom_buyback_item i JOIN public.tokyo_buyback_product p
      ON p.snapshot_id=p_snapshot_id AND p.id=i.source_shinsoku_id AND p.franchise=s.franchise AND p.product_type=s.product_type
    WHERE i.sheet_id=p_sheet_id
  ) THEN RAISE EXCEPTION 'missing or incompatible products; no prices changed' USING ERRCODE='22023'; END IF;
  UPDATE public.custom_buyback_item i SET
    card_name=p.name,list_no=p.model_number,image_url=p.image_url,
    final_price_high=CASE WHEN p_preserve_overrides AND (i.override_reason IS NOT NULL OR i.final_price_high IS DISTINCT FROM i.source_price_high)
      THEN i.final_price_high ELSE p.price_high END,
    override_reason=CASE WHEN p_preserve_overrides AND (i.override_reason IS NOT NULL OR i.final_price_high IS DISTINCT FROM i.source_price_high)
      THEN coalesce(i.override_reason,'価格更新前の手修正を維持') END,
    source_price_high=p.price_high,source_price_low=NULL,final_price_low=NULL,price_source_date=v_date,
    source_shop_name=CASE coalesce(p.selected_high_source,'shinsoku')
      WHEN 'kecak' THEN 'KECAK' WHEN 'blue_rocket' THEN 'Blue Rocket' WHEN 'toreca_bank' THEN 'トレカバンク'
      WHEN 'avirile' THEN 'アヴィリール' ELSE 'シンソク郵送買取' END,
    updated_at=now()
  FROM public.tokyo_buyback_product p WHERE i.sheet_id=p_sheet_id AND p.snapshot_id=p_snapshot_id AND p.id=i.source_shinsoku_id;
  UPDATE public.custom_buyback_sheet SET tokyo_snapshot_id=p_snapshot_id,price_business_date=v_date,status='draft',error_message=NULL,updated_at=now()
    WHERE id=p_sheet_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.add_custom_buyback_shinsoku_items(UUID,TEXT,TEXT[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.add_custom_buyback_shinsoku_items(UUID,TEXT,TEXT[]) TO service_role;
REVOKE ALL ON FUNCTION public.refresh_custom_buyback_shinsoku_prices(UUID,TEXT,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_custom_buyback_shinsoku_prices(UUID,TEXT,UUID,BOOLEAN) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
