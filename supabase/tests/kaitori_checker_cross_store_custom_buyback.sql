\set ON_ERROR_STOP on
BEGIN;
SELECT plan(6);

INSERT INTO public.kaitori_checker_sync_run (
  id, store, request_key, trigger, claim_token, status,
  product_count, offer_count, ranking_count, content_hash, started_at, completed_at
) VALUES
  ('71000000-0000-4000-8000-000000000001', 'oripark', 'cross-store-1', 'manual', 'token-1', 'applied', 1, 1, 1, repeat('1', 64), now(), now()),
  ('71000000-0000-4000-8000-000000000002', 'oripark', 'cross-store-2', 'manual', 'token-2', 'applied', 1, 1, 1, repeat('2', 64), now(), now());

INSERT INTO public.kaitori_checker_product_snapshot (
  run_id, store, source_product_id, category, name, model_number, image_url
) VALUES
  ('71000000-0000-4000-8000-000000000001', 'oripark', 701, 'pokemon', 'Shared PSA', 'P-701', 'https://img/701'),
  ('71000000-0000-4000-8000-000000000002', 'oripark', 701, 'pokemon', 'Shared PSA refreshed', 'P-701', 'https://img/701-new');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.kaitori_checker_product_snapshot (
      run_id, store, source_product_id, category, name
    ) VALUES (
      '71000000-0000-4000-8000-000000000001', 'oripark', 9007199254740992, 'pokemon', 'Unsafe ID'
    );
    RAISE EXCEPTION 'unsafe product ID unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;
SELECT pass('source product IDs stay within the JavaScript safe integer contract');

INSERT INTO public.kaitori_checker_offer_snapshot (
  run_id, store, source_product_id, shop_id, condition_id, edition_id,
  buy_price, shop_name, condition_name
) VALUES
  ('71000000-0000-4000-8000-000000000001', 'oripark', 701, 1, 1, 0, 1200, 'Source shop', 'PSA10'),
  ('71000000-0000-4000-8000-000000000002', 'oripark', 701, 2, 1, 0, 1500, 'New source shop', 'PSA10');

INSERT INTO public.custom_buyback_sheet (
  id, store, name, franchise, product_type, kind,
  price_snapshot_run_id, kaitori_checker_run_id, kaitori_checker_source_store, catalog_source,
  price_business_date, display_date
) VALUES (
  '72000000-0000-4000-8000-000000000001', 'manman-akihabara', '満満 PSA',
  'Pokemon', 'psa', 'store', NULL, '71000000-0000-4000-8000-000000000001',
  'oripark', 'kaitori_checker', '2026-09-04', '2026-09-04'
);

SELECT lives_ok(
  $$SELECT public.add_custom_buyback_kaitori_items(
    '72000000-0000-4000-8000-000000000001', 'manman-akihabara', ARRAY[701]::BIGINT[]
  )$$,
  'manman-owned sheet can add an item from the oripark source'
);

SELECT is(
  (SELECT ROW(sheet.store, sheet.kaitori_checker_source_store, item.final_price_high)::TEXT
   FROM public.custom_buyback_sheet AS sheet
   JOIN public.custom_buyback_item AS item ON item.sheet_id = sheet.id
   WHERE sheet.id = '72000000-0000-4000-8000-000000000001'),
  ROW('manman-akihabara'::TEXT, 'oripark'::TEXT, 1200::NUMERIC)::TEXT,
  'sheet ownership remains manman while price comes from oripark'
);

SELECT lives_ok(
  $$SELECT public.refresh_custom_buyback_kaitori_prices(
    '72000000-0000-4000-8000-000000000001', 'manman-akihabara',
    '71000000-0000-4000-8000-000000000002', '2026-09-05', FALSE
  )$$,
  'cross-store source refresh succeeds for the owning store'
);

SELECT is(
  (SELECT ROW(final_price_high, source_shop_name)::TEXT
   FROM public.custom_buyback_item
   WHERE sheet_id = '72000000-0000-4000-8000-000000000001'),
  ROW(1500::NUMERIC, 'New source shop'::TEXT)::TEXT,
  'refresh reads the next oripark snapshot'
);

DO $test$
BEGIN
  BEGIN
    PERFORM public.add_custom_buyback_kaitori_items(
      '72000000-0000-4000-8000-000000000001', 'oripark', ARRAY[701]::BIGINT[]
    );
    RAISE EXCEPTION 'source store unexpectedly gained sheet ownership';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END
$test$;
SELECT pass('source store cannot mutate a manman-owned sheet');

SELECT * FROM finish();
ROLLBACK;
