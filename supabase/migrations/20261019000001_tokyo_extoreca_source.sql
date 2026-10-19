BEGIN;

ALTER TABLE public.tokyo_buyback_product
  DROP CONSTRAINT tokyo_buyback_product_selected_high_source_check,
  DROP CONSTRAINT tokyo_buyback_product_selected_low_source_check,
  ADD CONSTRAINT tokyo_buyback_product_selected_high_source_check
    CHECK(selected_high_source IS NULL OR selected_high_source IN ('kecak','blue_rocket','extoreca','toreca_bank','avirile','shinsoku')),
  ADD CONSTRAINT tokyo_buyback_product_selected_low_source_check
    CHECK(selected_low_source IS NULL OR selected_low_source IN ('kecak','blue_rocket','extoreca','toreca_bank','avirile','shinsoku'));

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
      WHEN 'kecak' THEN 'KECAK' WHEN 'blue_rocket' THEN 'Blue Rocket' WHEN 'extoreca' THEN 'エクストレカ'
      WHEN 'toreca_bank' THEN 'トレカバンク' WHEN 'avirile' THEN 'アヴィリール' ELSE 'シンソク郵送買取' END
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
      WHEN 'kecak' THEN 'KECAK' WHEN 'blue_rocket' THEN 'Blue Rocket' WHEN 'extoreca' THEN 'エクストレカ'
      WHEN 'toreca_bank' THEN 'トレカバンク' WHEN 'avirile' THEN 'アヴィリール' ELSE 'シンソク郵送買取' END,
    updated_at=now()
  FROM public.tokyo_buyback_product p WHERE i.sheet_id=p_sheet_id AND p.snapshot_id=p_snapshot_id AND p.id=i.source_shinsoku_id;
  UPDATE public.custom_buyback_sheet SET tokyo_snapshot_id=p_snapshot_id,price_business_date=v_date,status='draft',error_message=NULL,updated_at=now()
    WHERE id=p_sheet_id;
END;
$$;

NOTIFY pgrst,'reload schema';
COMMIT;
