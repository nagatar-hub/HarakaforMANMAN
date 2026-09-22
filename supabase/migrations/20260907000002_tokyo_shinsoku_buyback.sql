BEGIN;

CREATE TABLE public.tokyo_buyback_snapshot (
  id UUID PRIMARY KEY,
  store TEXT NOT NULL CHECK (store = 'manman-akihabara'),
  order_list_import_id UUID NOT NULL REFERENCES public.order_list_import(id) ON DELETE RESTRICT,
  checker_run_id UUID NOT NULL,
  checker_source_store TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  business_date DATE NOT NULL,
  settings JSONB NOT NULL,
  report JSONB NOT NULL,
  -- The publish RPC verifies the source run. Keep its provenance ID after the
  -- checker's independent 90-day metadata retention deletes that run.
  UNIQUE(store, id)
);
CREATE INDEX ON public.tokyo_buyback_snapshot(fetched_at DESC);
CREATE TABLE public.tokyo_buyback_product (
  snapshot_id UUID NOT NULL REFERENCES public.tokyo_buyback_snapshot(id) ON DELETE RESTRICT,
  id TEXT NOT NULL CHECK(length(btrim(id)) BETWEEN 1 AND 200),
  franchise TEXT NOT NULL CHECK(franchise IN ('Pokemon','ONE PIECE','YU-GI-OH!','WEISS SCHWARZ','DRAGON BALL')),
  product_type TEXT NOT NULL CHECK(product_type IN ('psa','box')),
  name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
  model_number TEXT,
  image_url TEXT,
  source_price NUMERIC NOT NULL CHECK(source_price > 0 AND source_price <= 100000000 AND source_price = trunc(source_price)),
  price_high NUMERIC NOT NULL CHECK(price_high > 0 AND price_high <= source_price AND price_high = trunc(price_high)),
  origins JSONB NOT NULL CHECK(jsonb_typeof(origins) = 'array' AND jsonb_array_length(origins) > 0),
  PRIMARY KEY(snapshot_id, id)
);
ALTER TABLE public.tokyo_buyback_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokyo_buyback_product ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokyo_buyback_snapshot, public.tokyo_buyback_product FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tokyo_buyback_snapshot, public.tokyo_buyback_product TO service_role;

CREATE FUNCTION public.publish_tokyo_buyback_snapshot(p_snapshot JSONB, p_products JSONB)
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
  SELECT id INTO v_latest FROM public.order_list_import
    WHERE store = v_snapshot.store ORDER BY business_date DESC, created_at DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_snapshot.order_list_import_id OR NOT EXISTS (
    SELECT 1 FROM public.order_list_import WHERE id = v_latest
      AND status = 'applied' AND structural_valid AND persistence_complete
  ) THEN RAISE EXCEPTION 'latest complete Tokyo order list required' USING ERRCODE = '22023'; END IF;
  SELECT id INTO v_latest FROM public.kaitori_checker_sync_run
    WHERE store = v_snapshot.checker_source_store ORDER BY created_at DESC LIMIT 1;
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
  INSERT INTO public.tokyo_buyback_snapshot SELECT v_snapshot.*;
  INSERT INTO public.tokyo_buyback_product
    SELECT v_snapshot.id, p.id, p.franchise, p.product_type, p.name, p.model_number,
      p.image_url, p.source_price, p.price_high, p.origins
    FROM jsonb_to_recordset(p_products) AS p(id TEXT, franchise TEXT, product_type TEXT, name TEXT,
      model_number TEXT, image_url TEXT, source_price NUMERIC, price_high NUMERIC, origins JSONB);
  RETURN v_snapshot.id;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB) TO service_role;

ALTER TABLE public.custom_buyback_sheet
  ADD COLUMN tokyo_snapshot_id UUID,
  DROP CONSTRAINT chk_custom_buyback_sheet_catalog_source,
  DROP CONSTRAINT chk_custom_buyback_sheet_exactly_one_catalog,
  ADD CONSTRAINT chk_custom_buyback_sheet_catalog_source CHECK(catalog_source IN ('prepared_card','kaitori_checker','shinsoku')),
  ADD CONSTRAINT fk_custom_buyback_tokyo_snapshot FOREIGN KEY(store,tokyo_snapshot_id)
    REFERENCES public.tokyo_buyback_snapshot(store,id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_custom_buyback_sheet_exactly_one_catalog CHECK (
    (catalog_source = 'prepared_card' AND price_snapshot_run_id IS NOT NULL AND kaitori_checker_run_id IS NULL AND kaitori_checker_source_store IS NULL AND tokyo_snapshot_id IS NULL)
    OR (catalog_source = 'kaitori_checker' AND price_snapshot_run_id IS NULL AND kaitori_checker_run_id IS NOT NULL AND kaitori_checker_source_store IS NOT NULL AND tokyo_snapshot_id IS NULL)
    OR (catalog_source = 'shinsoku' AND store = 'manman-akihabara' AND price_snapshot_run_id IS NULL AND kaitori_checker_run_id IS NULL AND kaitori_checker_source_store IS NULL AND tokyo_snapshot_id IS NOT NULL)
  );
ALTER TABLE public.custom_buyback_item
  ADD COLUMN source_shinsoku_id TEXT,
  DROP CONSTRAINT custom_buyback_item_price_source_check,
  ADD CONSTRAINT custom_buyback_item_price_source_check CHECK(price_source IN ('order_list','kecak','spectre','manual','kaitori_checker','shinsoku')),
  ADD CONSTRAINT chk_custom_buyback_shinsoku_source CHECK (
    (price_source = 'shinsoku' AND source_shinsoku_id IS NOT NULL AND source_prepared_card_id IS NULL AND source_kaitori_product_id IS NULL)
    OR (price_source <> 'shinsoku' AND source_shinsoku_id IS NULL)
  );
CREATE UNIQUE INDEX ON public.custom_buyback_item(sheet_id,source_shinsoku_id) WHERE source_shinsoku_id IS NOT NULL;

CREATE FUNCTION public.add_custom_buyback_shinsoku_items(p_sheet_id UUID, p_store TEXT, p_product_ids TEXT[])
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
    p.price_high,p.price_high,'shinsoku',s.price_business_date,p.id,'シンソク郵送買取'
  FROM unnest(p_product_ids) WITH ORDINALITY t(id,ordinality)
  JOIN public.tokyo_buyback_product p ON p.snapshot_id=s.tokyo_snapshot_id AND p.id=t.id ORDER BY t.ordinality;
  UPDATE public.custom_buyback_sheet SET status='draft',error_message=NULL,updated_at=now() WHERE id=p_sheet_id;
END;
$$;
REVOKE ALL ON FUNCTION public.add_custom_buyback_shinsoku_items(UUID,TEXT,TEXT[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.add_custom_buyback_shinsoku_items(UUID,TEXT,TEXT[]) TO service_role;

CREATE FUNCTION public.refresh_custom_buyback_shinsoku_prices(p_sheet_id UUID,p_store TEXT,p_snapshot_id UUID,p_preserve_overrides BOOLEAN DEFAULT TRUE)
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
    source_price_high=p.price_high,source_price_low=NULL,final_price_low=NULL,price_source_date=v_date,updated_at=now()
  FROM public.tokyo_buyback_product p WHERE i.sheet_id=p_sheet_id AND p.snapshot_id=p_snapshot_id AND p.id=i.source_shinsoku_id;
  UPDATE public.custom_buyback_sheet SET tokyo_snapshot_id=p_snapshot_id,price_business_date=v_date,status='draft',error_message=NULL,updated_at=now()
    WHERE id=p_sheet_id;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_custom_buyback_shinsoku_prices(UUID,TEXT,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_custom_buyback_shinsoku_prices(UUID,TEXT,UUID,BOOLEAN) TO service_role;

-- Clone a complete row so new provenance columns cannot be omitted by a copied column list.
CREATE OR REPLACE FUNCTION public.clone_custom_buyback_sheet(p_sheet_id UUID,p_store TEXT,p_name TEXT,p_created_by TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.custom_buyback_sheet%ROWTYPE;
  i public.custom_buyback_item%ROWTYPE;
  v_id UUID := gen_random_uuid();
BEGIN
  IF length(btrim(coalesce(p_name,''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid name' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM public.custom_buyback_sheet WHERE id=p_sheet_id AND store=p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sheet not found' USING ERRCODE='P0002'; END IF;
  IF p_store='manman-akihabara' AND s.catalog_source <> 'shinsoku' THEN
    RAISE EXCEPTION 'create a new Tokyo sheet' USING ERRCODE='22023'; END IF;
  s.id:=v_id; s.name:=btrim(p_name); s.created_by:=nullif(btrim(p_created_by),'');
  s.status:='draft'; s.revision:=0; s.last_rendered_revision:=NULL; s.error_message:=NULL;
  s.created_at:=now(); s.updated_at:=now();
  INSERT INTO public.custom_buyback_sheet SELECT s.*;
  FOR i IN SELECT * FROM public.custom_buyback_item WHERE sheet_id=p_sheet_id ORDER BY position LOOP
    i.id:=gen_random_uuid(); i.sheet_id:=v_id; i.created_at:=now(); i.updated_at:=now();
    INSERT INTO public.custom_buyback_item SELECT i.*;
  END LOOP;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.clone_custom_buyback_sheet(UUID,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clone_custom_buyback_sheet(UUID,TEXT,TEXT,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
