\set ON_ERROR_STOP on
BEGIN;
SELECT plan(9);

UPDATE public.run
SET status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
WHERE status = 'running';
UPDATE public.order_list_import
SET status = 'applied', heartbeat_at = NULL
WHERE status IN ('confirmed', 'processing');

INSERT INTO public.db_card (
  id, franchise, tag, card_name, grade, list_no
) VALUES (
  '41000000-0000-0000-0000-000000000001',
  'Pokemon', 'TEST', 'Exclusion SQL Test Card', 'PSA10', 'EXCL-001'
);

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows, unmatched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000001', DATE '2099-02-01', 'applied',
  'exclusion-review.xlsx', 1, repeat('1', 64), 'tests/exclusion-review.xlsx',
  TRUE, TRUE, 2, 2, 1, 1
);

INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price,
  db_card_id, match_status
) VALUES
(
  '43000000-0000-0000-0000-000000000001',
  '42000000-0000-0000-0000-000000000001',
  'Pokemon', 'EXCL-MATCHED-1', 'Pokemon', 2, repeat('2', 64),
  'Exclusion SQL Test Card', 'PSA10', 'EXCL-001', 1, 100,
  '41000000-0000-0000-0000-000000000001', 'matched'
),
(
  '43000000-0000-0000-0000-000000000002',
  '42000000-0000-0000-0000-000000000001',
  'Pokemon', '  ＥＸＣＬ－ＰＲＯＤＵＣＴ－１  ', 'Pokemon', 3, repeat('3', 64),
  'Do Not Buy', 'PSA10', 'EXCL-002', 1, 200,
  NULL, 'unmatched'
);

DO $test$
DECLARE
  v_result JSONB;
  v_item public.order_list_item%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_import public.order_list_import%ROWTYPE;
BEGIN
  v_result := public.resolve_order_list_review_changes(
    '42000000-0000-0000-0000-000000000001',
    '[]'::JSONB,
    '[]'::JSONB,
    jsonb_build_array(jsonb_build_object(
      'item_id', '43000000-0000-0000-0000-000000000002'
    )),
    FALSE
  );
  SELECT * INTO v_item FROM public.order_list_item
  WHERE id = '43000000-0000-0000-0000-000000000002';
  SELECT * INTO v_mapping FROM public.excel_product_mapping
  WHERE id = v_item.mapping_id;
  SELECT * INTO v_import FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000001';

  IF (v_result ->> 'excluded')::INT <> 1
    OR v_item.match_status <> 'excluded'
    OR v_item.db_card_id IS NOT NULL
    OR v_mapping.status <> 'disabled'
    OR v_mapping.db_card_id IS NOT NULL
    OR v_mapping.excel_product_key <> 'excl-product-1'
    OR v_import.matched_rows <> 1
    OR v_import.excluded_rows <> 1
    OR v_import.valid_rows <> 2
    OR (v_import.sheet_counts -> 'Pokemon' ->> 'excluded')::INT <> 1 THEN
    RAISE EXCEPTION 'exclusion persistence/counts are wrong: %, %, %, %',
      v_result, row_to_json(v_item), row_to_json(v_mapping), row_to_json(v_import);
  END IF;
END;
$test$;
SELECT pass('review exclusion persists a normalized disabled mapping and exact counts');

DO $test$
DECLARE
  v_result JSONB;
  v_item public.order_list_item%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_import public.order_list_import%ROWTYPE;
BEGIN
  v_result := public.resolve_order_list_review_changes(
    '42000000-0000-0000-0000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'item_id', '43000000-0000-0000-0000-000000000002',
      'db_card_id', '41000000-0000-0000-0000-000000000001'
    )),
    '[]'::JSONB,
    '[]'::JSONB,
    FALSE
  );
  SELECT * INTO v_item FROM public.order_list_item
  WHERE id = '43000000-0000-0000-0000-000000000002';
  SELECT * INTO v_mapping FROM public.excel_product_mapping
  WHERE id = v_item.mapping_id;
  SELECT * INTO v_import FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000001';

  IF v_item.match_status <> 'matched'
    OR v_item.db_card_id <> '41000000-0000-0000-0000-000000000001'
    OR v_mapping.status <> 'active'
    OR v_mapping.db_card_id <> '41000000-0000-0000-0000-000000000001'
    OR v_import.matched_rows <> 2
    OR v_import.excluded_rows <> 0 THEN
    RAISE EXCEPTION 'explicit remap did not reactivate exclusion: %, %, %, %',
      v_result, row_to_json(v_item), row_to_json(v_mapping), row_to_json(v_import);
  END IF;
END;
$test$;
SELECT pass('an explicit DB mapping reactivates a previously excluded product');

DO $test$
DECLARE
  v_result JSONB;
  v_item public.order_list_item%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_db_card public.db_card%ROWTYPE;
  v_import public.order_list_import%ROWTYPE;
BEGIN
  PERFORM public.resolve_order_list_review_changes(
    '42000000-0000-0000-0000-000000000001',
    '[]'::JSONB,
    '[]'::JSONB,
    jsonb_build_array(jsonb_build_object(
      'item_id', '43000000-0000-0000-0000-000000000002'
    )),
    FALSE
  );
  v_result := public.resolve_order_list_review_changes(
    '42000000-0000-0000-0000-000000000001',
    '[]'::JSONB,
    jsonb_build_array(jsonb_build_object(
      'item_id', '43000000-0000-0000-0000-000000000002',
      'card_name', 'Restored Exclusion As New',
      'grade', 'PSA10',
      'list_no', 'EXCL-NEW-001',
      'tag', 'TEST',
      'alt_image_url', 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/excl-new.png'
    )),
    '[]'::JSONB,
    FALSE
  );

  SELECT * INTO v_item FROM public.order_list_item
  WHERE id = '43000000-0000-0000-0000-000000000002';
  SELECT * INTO v_mapping FROM public.excel_product_mapping
  WHERE id = v_item.mapping_id;
  SELECT * INTO v_db_card FROM public.db_card
  WHERE id = v_item.db_card_id;
  SELECT * INTO v_import FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000001';

  IF (v_result ->> 'created')::INT <> 1
    OR v_item.match_status <> 'matched'
    OR v_item.db_card_id IS NULL
    OR v_mapping.status <> 'active'
    OR v_mapping.db_card_id IS DISTINCT FROM v_item.db_card_id
    OR v_db_card.card_name <> 'Restored Exclusion As New'
    OR v_db_card.alt_image_url <> 'https://fexadnveyuqduiujewrc.supabase.co/storage/v1/object/public/cards/excl-new.png'
    OR v_import.matched_rows <> 2
    OR v_import.excluded_rows <> 0 THEN
    RAISE EXCEPTION 'new-card exclusion restore is wrong: %, %, %, %, %',
      v_result, row_to_json(v_item), row_to_json(v_mapping),
      row_to_json(v_db_card), row_to_json(v_import);
  END IF;
END;
$test$;
SELECT pass('a previously excluded product can be restored as a new DB card');

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, unmatched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000002', DATE '2099-02-02', 'applied',
  'exclusion-zero-matched.xlsx', 1, repeat('4', 64), 'tests/exclusion-zero-matched.xlsx',
  TRUE, TRUE, 1, 1, 1
);
INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price, match_status
) VALUES (
  '43000000-0000-0000-0000-000000000003',
  '42000000-0000-0000-0000-000000000002',
  'Pokemon', 'EXCL-ROLLBACK-1', 'Pokemon', 2, repeat('5', 64),
  'Rollback Exclusion', 'PSA10', 'EXCL-003', 1, 300, 'unmatched'
);

DO $test$
DECLARE
  v_status TEXT;
  v_mapping_count INT;
BEGIN
  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '42000000-0000-0000-0000-000000000002',
      '45000000-0000-0000-0000-000000000001',
      repeat('a1', 32),
      '[]'::JSONB,
      '[]'::JSONB,
      jsonb_build_array(jsonb_build_object(
        'item_id', '43000000-0000-0000-0000-000000000003'
      )),
      FALSE
    );
    RAISE EXCEPTION 'zero-matched re-sync unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  SELECT match_status INTO v_status FROM public.order_list_item
  WHERE id = '43000000-0000-0000-0000-000000000003';
  SELECT count(*)::INT INTO v_mapping_count
  FROM public.excel_product_mapping
  WHERE franchise = 'Pokemon'
    AND excel_product_key = 'excl-rollback-1';
  IF v_status <> 'unmatched' OR v_mapping_count <> 0 THEN
    RAISE EXCEPTION 'failed re-sync did not roll review changes back: %, %',
      v_status, v_mapping_count;
  END IF;
END;
$test$;
SELECT pass('re-sync queue rolls review changes back when no matched rows remain');

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows, unmatched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000003', DATE '2099-02-03', 'applied',
  'exclusion-resync.xlsx', 1, repeat('6', 64), 'tests/exclusion-resync.xlsx',
  TRUE, TRUE, 2, 2, 1, 1
);
INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price,
  db_card_id, match_status
) VALUES
(
  '43000000-0000-0000-0000-000000000004',
  '42000000-0000-0000-0000-000000000003',
  'Pokemon', 'EXCL-RESYNC-MATCHED', 'Pokemon', 2, repeat('7', 64),
  'Exclusion SQL Test Card', 'PSA10', 'EXCL-001', 1, 100,
  '41000000-0000-0000-0000-000000000001', 'matched'
),
(
  '43000000-0000-0000-0000-000000000005',
  '42000000-0000-0000-0000-000000000003',
  'Pokemon', 'EXCL-RESYNC-SKIP', 'Pokemon', 3, repeat('8', 64),
  'Resync Skip', 'PSA10', 'EXCL-004', 1, 400, NULL, 'unmatched'
);
INSERT INTO public.run (
  id, triggered_by, status, order_list_import_id
) VALUES (
  '44000000-0000-0000-0000-000000000001',
  'sql-exclusion-test', 'completed',
  '42000000-0000-0000-0000-000000000003'
);

DO $test$
DECLARE
  v_exclusions JSONB := jsonb_build_array(jsonb_build_object(
    'item_id', '43000000-0000-0000-0000-000000000005'
  ));
  v_first JSONB;
  v_second JSONB;
  v_after_failure JSONB;
  v_import public.order_list_import%ROWTYPE;
  v_completed_count INT;
BEGIN
  v_first := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000003',
    '45000000-0000-0000-0000-000000000002',
    repeat('a2', 32),
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  v_second := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000003',
    '45000000-0000-0000-0000-000000000002',
    repeat('a2', 32),
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  UPDATE public.order_list_import
  SET status = 'failed', heartbeat_at = NULL
  WHERE id = '42000000-0000-0000-0000-000000000003';
  v_after_failure := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000003',
    '45000000-0000-0000-0000-000000000002',
    repeat('a2', 32),
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  SELECT * INTO v_import FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000003';
  SELECT count(*)::INT INTO v_completed_count
  FROM public.run
  WHERE order_list_import_id = v_import.id AND status = 'completed';

  IF v_first ->> 'action' <> 'start_job'
    OR v_second ->> 'action' <> 'noop'
    OR (v_second ->> 'launch_pending')::BOOLEAN IS NOT TRUE
    OR v_after_failure ->> 'action' <> 'start_job'
    OR v_import.status <> 'confirmed'
    OR v_import.excluded_rows <> 1
    OR v_completed_count <> 1 THEN
    RAISE EXCEPTION 're-sync queue/lease is wrong: %, %, %, %, %',
      v_first, v_second, v_after_failure, row_to_json(v_import), v_completed_count;
  END IF;
END;
$test$;
SELECT pass('re-sync ignores completed history, leases double clicks, and can retry a failed execution');

UPDATE public.order_list_import
SET status = 'applied', heartbeat_at = NULL
WHERE id = '42000000-0000-0000-0000-000000000003';

INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows, unmatched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000005', DATE '2099-02-05', 'applied',
  'zero-selection-resync.xlsx', 1, repeat('c', 64),
  'tests/zero-selection-resync.xlsx',
  TRUE, TRUE, 2, 2, 1, 1
);
INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price,
  db_card_id, match_status
) VALUES
(
  '43000000-0000-0000-0000-000000000008',
  '42000000-0000-0000-0000-000000000005',
  'Pokemon', 'ZERO-RESYNC-MATCHED', 'Pokemon', 2, repeat('d', 64),
  'Exclusion SQL Test Card', 'PSA10', 'EXCL-001', 1, 100,
  '41000000-0000-0000-0000-000000000001', 'matched'
),
(
  '43000000-0000-0000-0000-000000000009',
  '42000000-0000-0000-0000-000000000005',
  'Pokemon', 'ZERO-RESYNC-UNMATCHED', 'Pokemon', 3, repeat('e', 64),
  'Unresolved Zero Selection', 'PSA10', 'EXCL-006', 1, 600, NULL, 'unmatched'
);

DO $test$
DECLARE
  v_result JSONB;
  v_import public.order_list_import%ROWTYPE;
BEGIN
  v_result := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000005',
    '45000000-0000-0000-0000-000000000003',
    repeat('a3', 32),
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, TRUE
  );
  SELECT * INTO v_import
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000005';

  IF v_result ->> 'action' <> 'start_job'
    OR (v_result ->> 'matched')::INT <> 1
    OR (v_result ->> 'unselected')::INT <> 1
    OR (v_result ->> 'excluded_total')::INT <> 0
    OR v_import.status <> 'confirmed'
    OR v_import.confirmation_allow_unresolved IS NOT TRUE
    OR v_import.heartbeat_at IS NULL THEN
    RAISE EXCEPTION 'zero-selection re-sync is wrong: %, %',
      v_result, row_to_json(v_import);
  END IF;
END;
$test$;
SELECT pass('an applied import can queue with zero selections while unresolved rows remain');

UPDATE public.order_list_import
SET status = 'applied', heartbeat_at = NULL
WHERE id = '42000000-0000-0000-0000-000000000005';
INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000006', DATE '2099-02-06', 'applied',
  'request-id-resync.xlsx', 1, repeat('f', 64),
  'tests/request-id-resync.xlsx',
  TRUE, TRUE, 1, 1, 1
);
INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price,
  db_card_id, match_status
) VALUES (
  '43000000-0000-0000-0000-000000000010',
  '42000000-0000-0000-0000-000000000006',
  'Pokemon', 'REQUEST-ID-MATCHED', 'Pokemon', 2, repeat('1f', 32),
  'Exclusion SQL Test Card', 'PSA10', 'EXCL-001', 1, 100,
  '41000000-0000-0000-0000-000000000001', 'matched'
);

DO $test$
DECLARE
  v_request_a CONSTANT UUID := '45000000-0000-0000-0000-000000000005';
  v_request_b CONSTANT UUID := '45000000-0000-0000-0000-000000000006';
  v_fingerprint_a CONSTANT TEXT := repeat('aa', 32);
  v_fingerprint_b CONSTANT TEXT := repeat('bb', 32);
  v_other_fingerprint CONSTANT TEXT := repeat('cc', 32);
  v_a_start JSONB;
  v_a_replay JSONB;
  v_b_start JSONB;
  v_delayed_a JSONB;
  v_lease_b_rejected BOOLEAN := FALSE;
  v_active_fingerprint_rejected BOOLEAN := FALSE;
  v_completed_fingerprint_rejected BOOLEAN := FALSE;
  v_wrong_import_rejected BOOLEAN := FALSE;
  v_a_run_count INT;
  v_b_run_count INT;
  v_owner_request_id UUID;
  v_owner_fingerprint TEXT;
  v_owner_allow_unresolved BOOLEAN;
BEGIN
  v_a_start := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000006',
    v_request_a, v_fingerprint_a,
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  );

  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '42000000-0000-0000-0000-000000000006',
      v_request_b, v_fingerprint_b,
      '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
    );
    RAISE EXCEPTION 'request B unexpectedly acquired request A lease';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_lease_b_rejected := TRUE;
  END;
  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '42000000-0000-0000-0000-000000000006',
      v_request_a, v_other_fingerprint,
      '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
    );
    RAISE EXCEPTION 'request A unexpectedly accepted another active fingerprint';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_active_fingerprint_rejected := TRUE;
  END;

  INSERT INTO public.run (
    id, triggered_by, status, order_list_import_id,
    order_list_sync_request_id, order_list_sync_request_fingerprint,
    completed_at
  ) VALUES (
    '44000000-0000-0000-0000-000000000003',
    'sql-request-id-test', 'completed',
    '42000000-0000-0000-0000-000000000006',
    v_request_a, v_fingerprint_a, clock_timestamp()
  );
  UPDATE public.order_list_import
  SET status = 'applied', heartbeat_at = NULL
  WHERE id = '42000000-0000-0000-0000-000000000006';

  v_a_replay := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000006',
    v_request_a, v_fingerprint_a,
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  );
  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '42000000-0000-0000-0000-000000000006',
      v_request_a, v_other_fingerprint,
      '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
    );
    RAISE EXCEPTION 'completed request A unexpectedly accepted another fingerprint';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_completed_fingerprint_rejected := TRUE;
  END;

  -- A different deliberate payload gets a new request ID and may start after A.
  v_b_start := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000006',
    v_request_b, v_fingerprint_b,
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, TRUE
  );
  INSERT INTO public.run (
    id, triggered_by, status, order_list_import_id,
    order_list_sync_request_id, order_list_sync_request_fingerprint,
    completed_at
  ) VALUES (
    '44000000-0000-0000-0000-000000000004',
    'sql-request-id-test', 'completed',
    '42000000-0000-0000-0000-000000000006',
    v_request_b, v_fingerprint_b, clock_timestamp()
  );
  UPDATE public.order_list_import
  SET status = 'applied', heartbeat_at = NULL
  WHERE id = '42000000-0000-0000-0000-000000000006';

  v_delayed_a := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000006',
    v_request_a, v_fingerprint_a,
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  );
  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '42000000-0000-0000-0000-000000000005',
      v_request_a, v_fingerprint_a,
      '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_wrong_import_rejected := TRUE;
  END;

  SELECT count(*)::INT INTO v_a_run_count
  FROM public.run
  WHERE order_list_sync_request_id = v_request_a;
  SELECT count(*)::INT INTO v_b_run_count
  FROM public.run
  WHERE order_list_sync_request_id = v_request_b;
  SELECT order_list_sync_request_id, order_list_sync_request_fingerprint,
         confirmation_allow_unresolved
  INTO v_owner_request_id, v_owner_fingerprint, v_owner_allow_unresolved
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000006';

  IF v_a_start ->> 'action' <> 'start_job'
    OR v_a_start ->> 'request_fingerprint' <> v_fingerprint_a
    OR NOT v_lease_b_rejected
    OR NOT v_active_fingerprint_rejected
    OR v_a_replay ->> 'action' <> 'noop'
    OR v_a_replay ->> 'request_fingerprint' <> v_fingerprint_a
    OR v_a_replay ->> 'run_id'
      <> '44000000-0000-0000-0000-000000000003'
    OR v_a_replay ->> 'run_status' <> 'completed'
    OR NOT v_completed_fingerprint_rejected
    OR v_b_start ->> 'action' <> 'start_job'
    OR v_b_start ->> 'request_fingerprint' <> v_fingerprint_b
    OR v_delayed_a ->> 'action' <> 'noop'
    OR v_delayed_a ->> 'request_fingerprint' <> v_fingerprint_a
    OR v_delayed_a ->> 'run_id'
      <> '44000000-0000-0000-0000-000000000003'
    OR NOT v_wrong_import_rejected
    OR v_a_run_count <> 1
    OR v_b_run_count <> 1
    OR v_owner_request_id IS DISTINCT FROM v_request_b
    OR v_owner_fingerprint IS DISTINCT FROM v_fingerprint_b
    OR v_owner_allow_unresolved IS NOT TRUE THEN
    RAISE EXCEPTION 'request fingerprint replay is wrong: %',
      jsonb_build_object(
        'a_start', v_a_start,
        'lease_b_rejected', v_lease_b_rejected,
        'active_fingerprint_rejected', v_active_fingerprint_rejected,
        'a_replay', v_a_replay,
        'completed_fingerprint_rejected', v_completed_fingerprint_rejected,
        'b_start', v_b_start,
        'delayed_a', v_delayed_a,
        'wrong_import_rejected', v_wrong_import_rejected,
        'a_runs', v_a_run_count,
        'b_runs', v_b_run_count,
        'owner_request_id', v_owner_request_id,
        'owner_fingerprint', v_owner_fingerprint,
        'owner_allow_unresolved', v_owner_allow_unresolved
      );
  END IF;
END;
$test$;
SELECT pass('request fingerprints bind active leases and make completed replays payload-safe');


INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows, processing_started_at, heartbeat_at
) VALUES (
  '42000000-0000-0000-0000-000000000007', DATE '2099-02-07', 'processing',
  'lease-renewal-fencing.xlsx', 1, repeat('7f', 32),
  'tests/lease-renewal-fencing.xlsx',
  TRUE, TRUE, 1, 1, 1,
  TIMESTAMPTZ '2099-02-07 00:00:00+00',
  TIMESTAMPTZ '2099-02-07 00:00:00+00'
);
INSERT INTO public.run (
  id, triggered_by, status, order_list_import_id
) VALUES (
  '44000000-0000-0000-0000-000000000005',
  'sql-lease-renewal-test', 'running',
  '42000000-0000-0000-0000-000000000007'
);

DO $test$
DECLARE
  v_active_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:01:00+00';
  v_reowned_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:02:00+00';
  v_stale_attempt_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:03:00+00';
  v_new_active_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:04:00+00';
  v_mismatch_owner_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:05:00+00';
  v_mismatch_attempt_time CONSTANT TIMESTAMPTZ :=
    TIMESTAMPTZ '2099-02-07 00:06:00+00';
  v_exact_active BOOLEAN;
  v_stale_old BOOLEAN;
  v_exact_new BOOLEAN;
  v_metadata_mismatch BOOLEAN;
  v_initial_style_null BOOLEAN;
  v_catalog_ok BOOLEAN;
  v_active_heartbeat TIMESTAMPTZ;
  v_stale_heartbeat TIMESTAMPTZ;
  v_new_heartbeat TIMESTAMPTZ;
  v_mismatch_heartbeat TIMESTAMPTZ;
BEGIN
  v_exact_active := public.renew_order_list_sync_lease(
    '42000000-0000-0000-0000-000000000007',
    '44000000-0000-0000-0000-000000000005',
    v_active_time
  );
  SELECT heartbeat_at INTO v_active_heartbeat
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000007';

  UPDATE public.run
  SET status = 'failed'
  WHERE id = '44000000-0000-0000-0000-000000000005';
  INSERT INTO public.run (
    id, triggered_by, status, order_list_import_id
  ) VALUES (
    '44000000-0000-0000-0000-000000000006',
    'sql-lease-renewal-test', 'running',
    '42000000-0000-0000-0000-000000000007'
  );
  UPDATE public.order_list_import
  SET heartbeat_at = v_reowned_time
  WHERE id = '42000000-0000-0000-0000-000000000007';

  SELECT
    target_import.order_list_sync_request_id IS NULL
      AND target_import.order_list_sync_request_fingerprint IS NULL
      AND bool_and(candidate_run.order_list_sync_request_id IS NULL)
      AND bool_and(
        candidate_run.order_list_sync_request_fingerprint IS NULL
      )
  INTO v_initial_style_null
  FROM public.order_list_import AS target_import
  JOIN public.run AS candidate_run
    ON candidate_run.order_list_import_id = target_import.id
  WHERE target_import.id = '42000000-0000-0000-0000-000000000007'
    AND candidate_run.id IN (
      '44000000-0000-0000-0000-000000000005',
      '44000000-0000-0000-0000-000000000006'
    )
  GROUP BY target_import.id;

  v_stale_old := public.renew_order_list_sync_lease(
    '42000000-0000-0000-0000-000000000007',
    '44000000-0000-0000-0000-000000000005',
    v_stale_attempt_time
  );
  SELECT heartbeat_at INTO v_stale_heartbeat
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000007';

  v_exact_new := public.renew_order_list_sync_lease(
    '42000000-0000-0000-0000-000000000007',
    '44000000-0000-0000-0000-000000000006',
    v_new_active_time
  );
  SELECT heartbeat_at INTO v_new_heartbeat
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000007';

  UPDATE public.order_list_import
  SET order_list_sync_request_id =
        '45000000-0000-0000-0000-000000000007',
      order_list_sync_request_fingerprint = repeat('dd', 32),
      heartbeat_at = v_mismatch_owner_time
  WHERE id = '42000000-0000-0000-0000-000000000007';
  v_metadata_mismatch := public.renew_order_list_sync_lease(
    '42000000-0000-0000-0000-000000000007',
    '44000000-0000-0000-0000-000000000006',
    v_mismatch_attempt_time
  );
  SELECT heartbeat_at INTO v_mismatch_heartbeat
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000007';

  SELECT
    function_catalog.prosecdef
      AND coalesce(
        'search_path=pg_catalog' = ANY(function_catalog.proconfig),
        FALSE
      )
      AND has_function_privilege(
        'service_role', function_catalog.oid, 'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated', function_catalog.oid, 'EXECUTE'
      )
      AND NOT has_function_privilege(
        'anon', function_catalog.oid, 'EXECUTE'
      )
  INTO v_catalog_ok
  FROM pg_catalog.pg_proc AS function_catalog
  WHERE function_catalog.oid =
    'public.renew_order_list_sync_lease(uuid,uuid,timestamptz)'::regprocedure;

  IF v_exact_active IS NOT TRUE
    OR v_active_heartbeat IS DISTINCT FROM v_active_time
    OR v_initial_style_null IS NOT TRUE
    OR v_stale_old IS NOT FALSE
    OR v_stale_heartbeat IS DISTINCT FROM v_reowned_time
    OR v_exact_new IS NOT TRUE
    OR v_new_heartbeat IS DISTINCT FROM v_new_active_time
    OR v_metadata_mismatch IS NOT FALSE
    OR v_mismatch_heartbeat IS DISTINCT FROM v_mismatch_owner_time
    OR v_catalog_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'lease renewal fence is wrong: %',
      jsonb_build_object(
        'exact_active', v_exact_active,
        'active_heartbeat', v_active_heartbeat,
        'initial_style_null', v_initial_style_null,
        'stale_old', v_stale_old,
        'stale_heartbeat', v_stale_heartbeat,
        'exact_new', v_exact_new,
        'new_heartbeat', v_new_heartbeat,
        'metadata_mismatch', v_metadata_mismatch,
        'mismatch_heartbeat', v_mismatch_heartbeat,
        'catalog_ok', v_catalog_ok
      );
  END IF;

  UPDATE public.run
  SET status = 'completed', completed_at = v_mismatch_owner_time
  WHERE id = '44000000-0000-0000-0000-000000000006';
  UPDATE public.order_list_import
  SET status = 'applied', heartbeat_at = NULL
  WHERE id = '42000000-0000-0000-0000-000000000007';
END;
$test$;
SELECT pass('lease renewal is fenced by exact Run and request ownership');
INSERT INTO public.order_list_import (
  id, business_date, status, original_filename, original_size_bytes, sha256,
  storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, matched_rows, unmatched_rows
) VALUES (
  '42000000-0000-0000-0000-000000000004', DATE '2099-02-08', 'parsed',
  'exclusion-confirm-processing.xlsx', 1, repeat('9', 64),
  'tests/exclusion-confirm-processing.xlsx',
  TRUE, TRUE, 2, 2, 1, 1
);
INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, demand, source_price,
  db_card_id, match_status
) VALUES
(
  '43000000-0000-0000-0000-000000000006',
  '42000000-0000-0000-0000-000000000004',
  'Pokemon', 'EXCL-CONFIRM-MATCHED', 'Pokemon', 2, repeat('a', 64),
  'Exclusion SQL Test Card', 'PSA10', 'EXCL-001', 1, 100,
  '41000000-0000-0000-0000-000000000001', 'matched'
),
(
  '43000000-0000-0000-0000-000000000007',
  '42000000-0000-0000-0000-000000000004',
  'Pokemon', 'EXCL-CONFIRM-SKIP', 'Pokemon', 3, repeat('b', 64),
  'Confirm Skip', 'PSA10', 'EXCL-005', 1, 500, NULL, 'unmatched'
);

DO $test$
DECLARE
  v_exclusions JSONB := jsonb_build_array(jsonb_build_object(
    'item_id', '43000000-0000-0000-0000-000000000007'
  ));
  v_confirm JSONB;
  v_confirm_retry JSONB;
  v_processing_without_run JSONB;
  v_processing_with_run JSONB;
  v_import public.order_list_import%ROWTYPE;
BEGIN
  v_confirm := public.confirm_order_list_import_review(
    '42000000-0000-0000-0000-000000000004',
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  v_confirm_retry := public.confirm_order_list_import_review(
    '42000000-0000-0000-0000-000000000004',
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  SELECT * INTO v_import
  FROM public.order_list_import
  WHERE id = '42000000-0000-0000-0000-000000000004';

  IF v_confirm ->> 'action' <> 'start_job'
    OR (v_confirm ->> 'excluded')::INT <> 1
    OR v_confirm_retry ->> 'action' <> 'noop'
    OR (v_confirm_retry ->> 'launch_pending')::BOOLEAN IS NOT TRUE
    OR v_import.status <> 'confirmed'
    OR v_import.matched_rows <> 1
    OR v_import.excluded_rows <> 1
    OR v_import.unmatched_rows <> 0
    OR v_import.valid_rows <> 2
    OR v_import.heartbeat_at IS NULL THEN
    RAISE EXCEPTION 'confirm exclusion/lease/counts are wrong: %, %, %',
      v_confirm, v_confirm_retry, row_to_json(v_import);
  END IF;

  UPDATE public.order_list_import
  SET status = 'processing',
      order_list_sync_request_id =
        '45000000-0000-0000-0000-000000000004',
      order_list_sync_request_fingerprint = repeat('a4', 32),
      processing_started_at = clock_timestamp(),
      heartbeat_at = clock_timestamp()
  WHERE id = '42000000-0000-0000-0000-000000000004';

  v_processing_without_run := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000004',
    '45000000-0000-0000-0000-000000000004',
    repeat('a4', 32),
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );
  INSERT INTO public.run (
    id, triggered_by, status, order_list_import_id,
    order_list_sync_request_id, order_list_sync_request_fingerprint
  ) VALUES (
    '44000000-0000-0000-0000-000000000002',
    'sql-exclusion-test', 'running',
    '42000000-0000-0000-0000-000000000004',
    '45000000-0000-0000-0000-000000000004', repeat('a4', 32)
  );
  v_processing_with_run := public.queue_order_list_import_resync(
    '42000000-0000-0000-0000-000000000004',
    '45000000-0000-0000-0000-000000000004',
    repeat('a4', 32),
    '[]'::JSONB, '[]'::JSONB, v_exclusions, FALSE
  );

  IF v_processing_without_run ->> 'action' <> 'noop'
    OR (v_processing_without_run ->> 'launch_pending')::BOOLEAN IS NOT TRUE
    OR v_processing_with_run ->> 'action' <> 'noop'
    OR (v_processing_with_run ->> 'launch_pending')::BOOLEAN IS NOT FALSE
    OR v_processing_with_run ->> 'run_id'
      <> '44000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'processing launch state is wrong: %, %',
      v_processing_without_run, v_processing_with_run;
  END IF;
END;
$test$;
SELECT pass('confirm and processing retries preserve exclusions, counters, and launch lease state');
SELECT * FROM finish();
ROLLBACK;
