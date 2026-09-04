\set ON_ERROR_STOP on
BEGIN;
SELECT plan(19);

INSERT INTO public.kaitori_checker_sync_run (
  id, store, request_key, trigger, claim_token, status,
  product_count, offer_count, ranking_count, content_hash, started_at, completed_at
) VALUES
  ('61000000-0000-4000-8000-000000000001', 'oripark', 'kc-buyback-1', 'manual', 'token-1', 'applied', 3, 6, 1, repeat('1', 64), now(), now()),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 'kc-buyback-2', 'manual', 'token-2', 'applied', 3, 4, 1, repeat('2', 64), now(), now()),
  ('61000000-0000-4000-8000-000000000003', 'manman', 'kc-buyback-3', 'manual', 'token-3', 'applied', 1, 1, 1, repeat('3', 64), now(), now());

INSERT INTO public.kaitori_checker_product_snapshot (
  run_id, store, source_product_id, category, name, full_name, model_number, rarity, image_url
) VALUES
  ('61000000-0000-4000-8000-000000000001', 'oripark', 101, 'pokemon', 'PSA card', 'PSA card full', 'P-101', 'SAR', 'https://img/101'),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 102, 'one_piece', 'Other category', NULL, 'OP-102', 'SEC', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 103, 'pokemon', 'BOX product', NULL, 'BOX-103', NULL, 'https://img/103'),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 101, 'pokemon', 'PSA card new', NULL, 'P-101', 'SAR', 'https://img/new-101'),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 102, 'one_piece', 'Other category new', NULL, 'OP-102', 'SEC', NULL),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 103, 'pokemon', 'BOX product new', NULL, 'BOX-103', NULL, 'https://img/new-103'),
  ('61000000-0000-4000-8000-000000000003', 'manman', 101, 'pokemon', 'Other store card', NULL, 'M-101', NULL, NULL);

INSERT INTO public.kaitori_checker_offer_snapshot (
  run_id, store, source_product_id, shop_id, condition_id, edition_id,
  buy_price, shop_name, condition_name, edition_name
) VALUES
  ('61000000-0000-4000-8000-000000000001', 'oripark', 101, 9, 1, 0, 1000, 'Low shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 101, 3, 1, 0, 1200, 'Tie later shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 101, 2, 1, 0, 1200, 'Tie chosen shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 101, 5, 2, 0, 900, 'BOX condition shop', '未開封BOX', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 102, 4, 1, 0, 800, 'Other category shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 103, 7, 2, 1, 5000, 'BOX shop', '未開封BOX', '初版'),
  ('61000000-0000-4000-8000-000000000001', 'oripark', 103, 8, 1, 0, 0, 'Zero shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 101, 8, 1, 0, 1500, 'New PSA shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 102, 4, 1, 0, 850, 'Other category shop', 'PSA10', NULL),
  ('61000000-0000-4000-8000-000000000002', 'oripark', 103, 6, 2, 0, 5500, 'New BOX shop', '未開封BOX', NULL),
  ('61000000-0000-4000-8000-000000000003', 'manman', 101, 1, 1, 0, 9999, 'Other store shop', 'PSA10', NULL);

INSERT INTO public.custom_buyback_sheet (
  id, store, name, franchise, product_type, kind,
  price_snapshot_run_id, kaitori_checker_run_id, catalog_source,
  price_business_date, display_date
) VALUES
  ('62000000-0000-4000-8000-000000000001', 'oripark', 'Kaitori PSA', 'Pokemon', 'psa', 'store',
    NULL, '61000000-0000-4000-8000-000000000001', 'kaitori_checker', '2026-09-04', '2026-09-04'),
  ('62000000-0000-4000-8000-000000000002', 'oripark', 'Kaitori BOX', 'Pokemon', 'box', 'store',
    NULL, '61000000-0000-4000-8000-000000000001', 'kaitori_checker', '2026-09-04', '2026-09-04');

SELECT is(
  (SELECT kaitori_checker_source_store FROM public.custom_buyback_sheet
   WHERE id = '62000000-0000-4000-8000-000000000001'),
  'oripark'::TEXT,
  'legacy inserts default the kaitori source store to the owning store'
);

SELECT is(
  (SELECT buy_price FROM public.kaitori_checker_custom_buyback_catalog
   WHERE run_id = '61000000-0000-4000-8000-000000000001'
     AND source_product_id = 101 AND condition_id = 1),
  1200::NUMERIC,
  'catalog selects the highest offer'
);

SELECT is(
  (SELECT shop_id FROM public.kaitori_checker_custom_buyback_catalog
   WHERE run_id = '61000000-0000-4000-8000-000000000001'
     AND source_product_id = 101 AND condition_id = 1),
  2::BIGINT,
  'equal maximum offers use a deterministic shop tie-breaker'
);

SELECT is(
  (SELECT count(*)::INT FROM public.kaitori_checker_custom_buyback_catalog
   WHERE run_id = '61000000-0000-4000-8000-000000000001'
     AND source_product_id = 103 AND condition_id = 1),
  0,
  'zero-price offers are not exposed as renderable catalog products'
);

SELECT lives_ok(
  $$SELECT public.add_custom_buyback_kaitori_items(
    '62000000-0000-4000-8000-000000000001', 'oripark', ARRAY[101]::BIGINT[]
  )$$,
  'PSA product can be added from the linked applied run'
);

SELECT is(
  (SELECT ROW(source_price_high, final_price_high, source_price_low, final_price_low,
              source_kaitori_condition_id, source_kaitori_shop_id, price_source, demand)::TEXT
   FROM public.custom_buyback_item
   WHERE sheet_id = '62000000-0000-4000-8000-000000000001'),
  ROW(1200::NUMERIC, 1200::NUMERIC, NULL::NUMERIC, NULL::NUMERIC,
      1::BIGINT, 2::BIGINT, 'kaitori_checker'::TEXT, 1::INT)::TEXT,
  'PSA item keeps the exact maximum as high, no low price, and demand defaults to one'
);

SELECT lives_ok(
  $$SELECT public.add_custom_buyback_kaitori_items(
    '62000000-0000-4000-8000-000000000002', 'oripark', ARRAY[103]::BIGINT[]
  )$$,
  'BOX product can be added with condition two'
);

SELECT is(
  (SELECT ROW(source_kaitori_condition_id, source_price_high, final_price_low, tag)::TEXT
   FROM public.custom_buyback_item
   WHERE sheet_id = '62000000-0000-4000-8000-000000000002'),
  ROW(2::BIGINT, 5000::NUMERIC, NULL::NUMERIC, 'BOX'::TEXT)::TEXT,
  'BOX item uses only the condition-two maximum and has no low price'
);

DO $test$
BEGIN
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '62000000-0000-4000-8000-000000000001', 'oripark', ARRAY[102]::BIGINT[]
    );
    RAISE EXCEPTION 'wrong category unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (SELECT count(*) FROM public.custom_buyback_item
      WHERE sheet_id = '62000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'failed add was not atomic';
  END IF;
END
$test$;
SELECT pass('wrong category is rejected atomically');

DO $test$
BEGIN
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '62000000-0000-4000-8000-000000000001', 'oripark', ARRAY[103]::BIGINT[]
    );
    RAISE EXCEPTION 'wrong condition unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$test$;
SELECT pass('PSA sheet rejects a product without a condition-one offer');

DO $test$
BEGIN
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '62000000-0000-4000-8000-000000000001', 'oripark', ARRAY[101, 101]::BIGINT[]
    );
    RAISE EXCEPTION 'duplicate array unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '62000000-0000-4000-8000-000000000001', 'oripark', ARRAY[101]::BIGINT[]
    );
    RAISE EXCEPTION 'existing duplicate unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$test$;
SELECT pass('duplicate input and an already-added product are rejected');

UPDATE public.custom_buyback_sheet SET status = 'rendering'
WHERE id = '62000000-0000-4000-8000-000000000002';
DO $test$
BEGIN
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '62000000-0000-4000-8000-000000000002', 'oripark', ARRAY[101]::BIGINT[]
    );
    RAISE EXCEPTION 'rendering mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$test$;
SELECT pass('a rendering sheet rejects item mutation');
UPDATE public.custom_buyback_sheet SET status = 'draft'
WHERE id = '62000000-0000-4000-8000-000000000002';

DO $test$
BEGIN
  BEGIN
    PERFORM public.refresh_custom_buyback_kaitori_prices(
      '62000000-0000-4000-8000-000000000001', 'oripark',
      '61000000-0000-4000-8000-000000000003', '2026-09-05', TRUE
    );
    RAISE EXCEPTION 'other store run unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$test$;
SELECT pass('refresh rejects an applied run belonging to another store');

UPDATE public.custom_buyback_item
SET final_price_high = 1111, override_reason = '手修正', demand = 3
WHERE sheet_id = '62000000-0000-4000-8000-000000000001';
SELECT lives_ok(
  $$SELECT public.refresh_custom_buyback_kaitori_prices(
    '62000000-0000-4000-8000-000000000001', 'oripark',
    '61000000-0000-4000-8000-000000000002', '2026-09-05', TRUE
  )$$,
  'refresh can preserve this sheet manual edits'
);

SELECT is(
  (SELECT ROW(source_price_high, final_price_high, demand, source_kaitori_shop_id)::TEXT
   FROM public.custom_buyback_item
   WHERE sheet_id = '62000000-0000-4000-8000-000000000001'),
  ROW(1500::NUMERIC, 1111::NUMERIC, 3::INT, 8::BIGINT)::TEXT,
  'preserving refresh advances source metadata but keeps price and demand overrides'
);

SELECT lives_ok(
  $$SELECT public.refresh_custom_buyback_kaitori_prices(
    '62000000-0000-4000-8000-000000000001', 'oripark',
    '61000000-0000-4000-8000-000000000002', '2026-09-05', FALSE
  )$$,
  'refresh can discard this sheet manual price edits'
);

SELECT is(
  (SELECT ROW(final_price_high, override_reason, demand)::TEXT
   FROM public.custom_buyback_item
   WHERE sheet_id = '62000000-0000-4000-8000-000000000001'),
  ROW(1500::NUMERIC, NULL::TEXT, 3::INT)::TEXT,
  'non-preserving refresh resets price only while retaining demand'
);

DO $test$
BEGIN
  BEGIN
    UPDATE public.custom_buyback_item SET demand = 0
    WHERE sheet_id = '62000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'zero demand unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.custom_buyback_item SET demand = 1000
    WHERE sheet_id = '62000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'excessive demand unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
SELECT pass('demand is constrained to 1 through 999');

CREATE TEMP TABLE cloned_kaitori_sheet AS
SELECT public.clone_custom_buyback_sheet(
  '62000000-0000-4000-8000-000000000001', 'oripark', 'Kaitori clone', 'test'
) AS id;
SELECT is(
  (SELECT ROW(sheet.catalog_source, sheet.price_snapshot_run_id,
              sheet.kaitori_checker_run_id, item.source_kaitori_product_id,
              item.source_kaitori_condition_id, item.source_kaitori_shop_id,
              item.source_kaitori_edition_id, item.source_shop_name, item.demand)::TEXT
   FROM cloned_kaitori_sheet AS cloned
   JOIN public.custom_buyback_sheet AS sheet ON sheet.id = cloned.id
   JOIN public.custom_buyback_item AS item ON item.sheet_id = sheet.id),
  ROW('kaitori_checker'::TEXT, NULL::UUID,
      '61000000-0000-4000-8000-000000000002'::UUID,
      101::BIGINT, 1::BIGINT, 8::BIGINT, 0::BIGINT, 'New PSA shop'::TEXT, 3::INT)::TEXT,
  'clone copies the catalog source, linked run, source identity, shop, and demand'
);

SELECT * FROM finish();
ROLLBACK;
