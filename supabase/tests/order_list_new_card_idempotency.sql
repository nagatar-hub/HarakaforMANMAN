\set ON_ERROR_STOP on
BEGIN;
SELECT plan(3);

-- Keep the fixture isolated from any developer data while preserving it on
-- rollback. Confirm enforces a global single-running/single-active invariant.
UPDATE public.run
SET status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
WHERE status = 'running';
UPDATE public.order_list_import
SET status = 'applied', heartbeat_at = NULL
WHERE status IN ('confirmed', 'processing');

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, unmatched_rows
) VALUES (
  '10000000-0000-0000-0000-000000000001', DATE '2099-01-01', 'applied',
  'idempotency-applied.xlsx', 1, repeat('a', 64), 'tests/idempotency-applied.xlsx',
  TRUE, TRUE, 1, 1, 1
);

INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, image_url, demand, source_price,
  match_status
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Pokemon', 'IDEMPOTENCY-NEW-1', 'Pokemon', 2, repeat('b', 64),
  'Idempotency New Card', 'PSA10', 'IDEM-001',
  'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/test.png',
  1, 100, 'unmatched'
);

DO $test$
DECLARE
  v_selection JSONB := jsonb_build_array(jsonb_build_object(
    'item_id', '20000000-0000-0000-0000-000000000001',
    'card_name', 'Idempotency New Card',
    'grade', 'PSA10',
    'list_no', 'IDEM-001',
    'tag', 'TOP',
    'alt_image_url', NULL
  ));
  v_retry JSONB;
BEGIN
  PERFORM public.resolve_order_list_item_selections(
    '10000000-0000-0000-0000-000000000001', '[]'::JSONB, v_selection, TRUE
  );
  v_retry := public.resolve_order_list_item_selections(
    '10000000-0000-0000-0000-000000000001', '[]'::JSONB, v_selection, TRUE
  );
  IF (v_retry ->> 'reused')::INT <> 1 OR (v_retry ->> 'resolved')::INT <> 1 THEN
    RAISE EXCEPTION 'exact new-card retry was not treated as semantic reuse: %', v_retry;
  END IF;

  BEGIN
    PERFORM public.resolve_order_list_item_selections(
      '10000000-0000-0000-0000-000000000001',
      '[]'::JSONB,
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-0000-0000-000000000001',
        'card_name', 'Different Card',
        'grade', 'PSA10',
        'list_no', 'IDEM-001',
        'tag', 'TOP',
        'alt_image_url', NULL
      )),
      TRUE
    );
    RAISE EXCEPTION 'mismatching new-card retry unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.resolve_order_list_item_selections(
      '10000000-0000-0000-0000-000000000001',
      '[]'::JSONB,
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-0000-0000-000000000001',
        'card_name', 'Idempotency New Card',
        'grade', 'PSA10',
        'list_no', 'IDEM-001',
        'tag', 'DIFFERENT-TAG',
        'alt_image_url', NULL
      )),
      TRUE
    );
    RAISE EXCEPTION 'changed-tag retry unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.resolve_order_list_item_selections(
      '10000000-0000-0000-0000-000000000001',
      '[]'::JSONB,
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-0000-0000-000000000001',
        'card_name', 'Idempotency New Card',
        'grade', 'PSA10',
        'list_no', 'IDEM-001',
        'tag', 'TOP',
        'alt_image_url', 'https://firebasestorage.googleapis.com/v0/b/test.png'
      )),
      TRUE
    );
    RAISE EXCEPTION 'changed-alt-image retry unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$test$;
SELECT pass('new-card resolver accepts exact retry and rejects changed identity, tag, or alt image');

INSERT INTO public.run (
  id, triggered_by, status, order_list_import_id
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  'sql-idempotency-test', 'completed',
  '10000000-0000-0000-0000-000000000001'
);

DO $test$
DECLARE
  v_selection JSONB := jsonb_build_array(jsonb_build_object(
    'item_id', '20000000-0000-0000-0000-000000000001',
    'card_name', 'Idempotency New Card',
    'grade', 'PSA10',
    'list_no', 'IDEM-001',
    'tag', 'TOP',
    'alt_image_url', NULL
  ));
  v_result JSONB;
BEGIN
  v_result := public.confirm_order_list_import_selections(
    '10000000-0000-0000-0000-000000000001', '[]'::JSONB, v_selection, TRUE
  );
  IF v_result ->> 'action' <> 'noop' THEN
    RAISE EXCEPTION 'completed-run exact replay was not a noop: %', v_result;
  END IF;

  BEGIN
    PERFORM public.confirm_order_list_import_selections(
      '10000000-0000-0000-0000-000000000001',
      '[]'::JSONB,
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-0000-0000-000000000001',
        'card_name', 'Different Card',
        'grade', 'PSA10',
        'list_no', 'IDEM-001',
        'tag', 'TOP',
        'alt_image_url', NULL
      )),
      TRUE
    );
    RAISE EXCEPTION 'completed-run mismatching replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

END;
$test$;
SELECT pass('completed-run confirm replay is idempotent and mismatch-safe');

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, unmatched_rows
) VALUES (
  '10000000-0000-0000-0000-000000000002', DATE '2099-01-02', 'parsed',
  'idempotency-confirmed.xlsx', 1, repeat('c', 64), 'tests/idempotency-confirmed.xlsx',
  TRUE, TRUE, 1, 1, 1
);

INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, image_url, demand, source_price,
  match_status
) VALUES (
  '20000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'Pokemon', 'IDEMPOTENCY-MAP-2', 'Pokemon', 2, repeat('d', 64),
  'Idempotency Mapping Card', 'PSA10', 'IDEM-002',
  'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/test2.png',
  1, 200, 'unmatched'
);

DO $test$
DECLARE
  v_card_id UUID;
  v_mapping JSONB;
  v_result JSONB;
BEGIN
  SELECT db_card_id INTO v_card_id
  FROM public.order_list_item
  WHERE id = '20000000-0000-0000-0000-000000000001';

  v_mapping := jsonb_build_array(jsonb_build_object(
    'item_id', '20000000-0000-0000-0000-000000000002',
    'db_card_id', v_card_id
  ));
  v_result := public.confirm_order_list_import_selections(
    '10000000-0000-0000-0000-000000000002', v_mapping, '[]'::JSONB, FALSE
  );
  IF v_result ->> 'action' <> 'start_job' THEN
    RAISE EXCEPTION 'initial confirmed transition did not claim launch: %', v_result;
  END IF;

  v_result := public.confirm_order_list_import_selections(
    '10000000-0000-0000-0000-000000000002', v_mapping, '[]'::JSONB, FALSE
  );
  IF v_result ->> 'action' <> 'noop' THEN
    RAISE EXCEPTION 'confirmed exact replay was not a noop: %', v_result;
  END IF;

  BEGIN
    PERFORM public.confirm_order_list_import_selections(
      '10000000-0000-0000-0000-000000000002',
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-0000-0000-000000000002',
        'db_card_id', gen_random_uuid()
      )),
      '[]'::JSONB,
      FALSE
    );
    RAISE EXCEPTION 'confirmed mismatching replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.confirm_order_list_import_selections(
      '10000000-0000-0000-0000-000000000002',
      v_mapping,
      '[]'::JSONB,
      TRUE
    );
    RAISE EXCEPTION 'changed allow_unresolved replay unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$test$;
SELECT pass('confirmed launch replay is idempotent and mismatch-safe');

SELECT * FROM finish();
ROLLBACK;
