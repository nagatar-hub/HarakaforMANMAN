BEGIN;
ALTER TABLE public.run ADD COLUMN tokyo_snapshot_id UUID,
  ADD CONSTRAINT fk_run_tokyo_snapshot FOREIGN KEY(store,tokyo_snapshot_id)
    REFERENCES public.tokyo_buyback_snapshot(store,id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_run_tokyo_snapshot CHECK(tokyo_snapshot_id IS NULL OR store='manman-akihabara');

ALTER TABLE public.prepared_card ADD COLUMN source_shinsoku_id TEXT,
  DROP CONSTRAINT chk_prepared_card_price_source,
  ADD CONSTRAINT chk_prepared_card_price_source CHECK(price_source IN ('order_list','kecak','spectre','manual','shinsoku')),
  ADD CONSTRAINT chk_prepared_shinsoku_source CHECK(
    (source_shinsoku_id IS NULL AND source IS DISTINCT FROM 'shinsoku' AND price_source <> 'shinsoku')
    OR (source_shinsoku_id IS NOT NULL AND source='shinsoku' AND price_source='shinsoku'));
CREATE UNIQUE INDEX ON public.prepared_card(run_id,source_shinsoku_id) WHERE source_shinsoku_id IS NOT NULL;

CREATE FUNCTION public.check_prepared_shinsoku_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.source_shinsoku_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.run r JOIN public.tokyo_buyback_product p ON p.snapshot_id=r.tokyo_snapshot_id
    WHERE r.id=NEW.run_id AND r.store='manman-akihabara' AND p.id=NEW.source_shinsoku_id
      AND p.franchise=NEW.franchise AND p.name=NEW.card_name AND p.model_number IS NOT DISTINCT FROM NEW.list_no
      AND NEW.price_high=p.price_high AND NEW.price_low=p.price_high
      AND NEW.tag=CASE p.product_type WHEN 'box' THEN 'BOX' ELSE 'PSA10' END
      AND NEW.grade=CASE p.product_type WHEN 'box' THEN '未開封BOX' ELSE 'PSA10' END
  ) THEN RAISE EXCEPTION 'prepared product must match its Tokyo snapshot' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_prepared_shinsoku_snapshot BEFORE INSERT OR UPDATE ON public.prepared_card
  FOR EACH ROW EXECUTE FUNCTION public.check_prepared_shinsoku_snapshot();

-- Preserve two-argument custom callers via the optional claim parameter.
DROP FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB);
CREATE FUNCTION public.publish_tokyo_buyback_snapshot(p_snapshot JSONB, p_products JSONB, p_run_id UUID DEFAULT NULL)
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
  IF p_run_id IS NOT NULL THEN
    UPDATE public.run SET tokyo_snapshot_id=v_snapshot.id WHERE id=p_run_id;
  END IF;
  RETURN v_snapshot.id;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tokyo_buyback_snapshot(JSONB, JSONB, UUID) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;

