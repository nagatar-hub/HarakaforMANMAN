BEGIN;
-- Tags describe card groups; PSA/BOX identity remains enforced by grade.
CREATE OR REPLACE FUNCTION public.check_prepared_shinsoku_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.source_shinsoku_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.run r JOIN public.tokyo_buyback_product p ON p.snapshot_id=r.tokyo_snapshot_id
      JOIN public.tokyo_buyback_snapshot s ON s.id=p.snapshot_id
      CROSS JOIN LATERAL (
        -- Match calculateBoxPrice: apply no_shrink once to the stored upper price.
        -- The upper price already includes shrink; do not apply shrink again.
        -- float8 preserves the JavaScript arithmetic at tier/rounding boundaries.
        SELECT p.price_high::DOUBLE PRECISION * (1::DOUBLE PRECISION -
          (s.settings->'box_discount_rates'->p.franchise->>'no_shrink')::DOUBLE PRECISION) AS raw_low
      ) lower_price
    WHERE r.id=NEW.run_id AND r.store='manman-akihabara' AND p.id=NEW.source_shinsoku_id
      AND p.franchise=NEW.franchise AND p.name=NEW.card_name AND p.model_number IS NOT DISTINCT FROM NEW.list_no
      AND NEW.price_high=p.price_high
      AND NEW.price_low=CASE p.product_type WHEN 'box' THEN
        CASE WHEN jsonb_typeof(s.settings->'box_discount_rates'->p.franchise->'no_shrink')='number'
          AND (s.settings->'box_discount_rates'->p.franchise->>'no_shrink')::DOUBLE PRECISION BETWEEN 0 AND 1 THEN
          CASE WHEN lower_price.raw_low <= 0 THEN 0 ELSE
            FLOOR(lower_price.raw_low / CASE
              WHEN lower_price.raw_low < 10000 THEN 100
              WHEN lower_price.raw_low < 100000 THEN 1000
              WHEN lower_price.raw_low < 1000000 THEN 10000 ELSE 100000 END)
            * CASE WHEN lower_price.raw_low < 10000 THEN 100
              WHEN lower_price.raw_low < 100000 THEN 1000
              WHEN lower_price.raw_low < 1000000 THEN 10000 ELSE 100000 END
          END
        ELSE NULL END
        ELSE p.price_high END
      AND CASE p.product_type WHEN 'box' THEN NEW.tag='BOX'
        ELSE NULLIF(BTRIM(NEW.tag),'') IS NOT NULL AND NEW.tag <> 'BOX' END
      AND NEW.grade=CASE p.product_type WHEN 'box' THEN '未開封BOX' ELSE 'PSA10' END
  ) THEN RAISE EXCEPTION 'prepared product must match its Tokyo snapshot' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
