\set ON_ERROR_STOP on
BEGIN;
SELECT plan(41);

UPDATE public.run
SET status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
WHERE status = 'running';
UPDATE public.order_list_import
SET status = 'applied', heartbeat_at = NULL
WHERE status IN ('confirmed', 'processing');

SELECT is(
  (SELECT count(*)::INT
   FROM public.variable_registry
   WHERE store = 'manman'
     AND (source = 'system' OR is_deletable IS FALSE)),
  (SELECT count(*)::INT
   FROM public.variable_registry
   WHERE store = 'oripark'
     AND (source = 'system' OR is_deletable IS FALSE)),
  'the contract migration snapshots all system variables for MANMAN'
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.variable_registry
   WHERE key = 'date' AND store IN ('oripark', 'manman')),
  2,
  'the same system variable key exists independently in both stores'
);

SELECT is(
  (
    (SELECT count(*) FROM public.x_credential WHERE store = 'manman')
    + (SELECT count(*) FROM public.post_template WHERE store = 'manman')
    + (SELECT count(*) FROM public.post_banner WHERE store = 'manman')
  )::INT,
  0,
  'credentials and branded templates or banners are not cloned into MANMAN'
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.variable_registry
   WHERE store = 'manman' AND source = 'custom'),
  0,
  'custom Oripark variables are not cloned into MANMAN'
);

INSERT INTO public.x_credential (
  id, store, account_name, x_user_id, x_username,
  access_token, refresh_token, status, is_default
) VALUES
(
  '56000000-0000-0000-0000-000000000001', 'oripark',
  'Oripark test account', 'shared-x-user', 'shared_test',
  'oripark-access-token', 'oripark-refresh-token', 'active', TRUE
),
(
  '56000000-0000-0000-0000-000000000002', 'manman',
  'MANMAN test account', 'shared-x-user', 'shared_test',
  'manman-access-token', 'manman-refresh-token', 'active', TRUE
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.x_credential
   WHERE x_user_id = 'shared-x-user'),
  2,
  'the same X user may have one independent credential per store'
);

SELECT is(
  (SELECT count(DISTINCT access_token)::INT
   FROM public.x_credential
   WHERE x_user_id = 'shared-x-user'),
  2,
  'credential tokens remain independent across stores'
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.x_credential (
      id, store, account_name, status, is_default
    ) VALUES (
      '56000000-0000-0000-0000-000000000003', 'manman',
      'Second MANMAN default', 'active', TRUE
    );
    RAISE EXCEPTION 'second MANMAN default credential unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('only one default X credential is allowed per store');

INSERT INTO public.post_template (
  id, store, name, franchise, header_template, is_default
) VALUES
(
  '56100000-0000-0000-0000-000000000001', 'oripark',
  'Shared template identity', 'TEST', 'Oripark header', FALSE
),
(
  '56100000-0000-0000-0000-000000000002', 'manman',
  'Shared template identity', 'TEST', 'MANMAN header', FALSE
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.post_template
   WHERE name = 'Shared template identity' AND franchise = 'TEST'),
  2,
  'templates with the same business identity are independent by store'
);

INSERT INTO public.post_banner (
  id, store, franchise, name, image_url, position_type, is_default
) VALUES
(
  '56200000-0000-0000-0000-000000000001', 'oripark',
  'TEST', 'Shared banner identity', 'https://example.com/oripark-banner.png',
  'last', FALSE
),
(
  '56200000-0000-0000-0000-000000000002', 'manman',
  'TEST', 'Shared banner identity', 'https://example.com/manman-banner.png',
  'last', FALSE
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.post_banner
   WHERE name = 'Shared banner identity' AND franchise = 'TEST'),
  2,
  'banners with the same business identity are independent by store'
);

INSERT INTO public.post_template (
  id, store, name, franchise, header_template, is_default
) VALUES
(
  '56100000-0000-0000-0000-000000000003', 'oripark',
  'Oripark default template', 'TEST-DEFAULT', 'Oripark default', TRUE
),
(
  '56100000-0000-0000-0000-000000000004', 'manman',
  'MANMAN default template', 'TEST-DEFAULT', 'MANMAN default', TRUE
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.post_template
   WHERE franchise = 'TEST-DEFAULT' AND is_default IS TRUE),
  2,
  'each store may have its own default template for a franchise'
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_template (
      id, store, name, franchise, header_template, is_default
    ) VALUES (
      '56100000-0000-0000-0000-000000000005', 'manman',
      'Second MANMAN default template', 'TEST-DEFAULT', 'duplicate', TRUE
    );
    RAISE EXCEPTION 'second MANMAN default template unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('only one default template is allowed per store and franchise');

INSERT INTO public.post_banner (
  id, store, franchise, name, image_url, position_type, is_default
) VALUES
(
  '56200000-0000-0000-0000-000000000003', 'oripark',
  'TEST-DEFAULT', 'Oripark default banner', 'https://example.com/oripark-default.png',
  'last', TRUE
),
(
  '56200000-0000-0000-0000-000000000004', 'manman',
  'TEST-DEFAULT', 'MANMAN default banner', 'https://example.com/manman-default.png',
  'last', TRUE
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.post_banner
   WHERE franchise = 'TEST-DEFAULT' AND is_default IS TRUE),
  2,
  'each store may have its own default banner for a franchise'
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_banner (
      id, store, franchise, name, image_url, position_type, is_default
    ) VALUES (
      '56200000-0000-0000-0000-000000000005', 'manman',
      'TEST-DEFAULT', 'Second MANMAN default banner',
      'https://example.com/manman-default-2.png', 'last', TRUE
    );
    RAISE EXCEPTION 'second MANMAN default banner unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('only one default banner is allowed per store and franchise');

INSERT INTO public.run (
  id, triggered_by, store, status, completed_at
) VALUES
(
  '56300000-0000-0000-0000-000000000001',
  'sql-posting-store-isolation', 'oripark', 'completed', clock_timestamp()
),
(
  '56300000-0000-0000-0000-000000000002',
  'sql-posting-store-isolation', 'manman', 'completed', clock_timestamp()
);

INSERT INTO public.post_plan (
  id, store, run_id, franchise, template_id, banner_id, x_credential_id
) VALUES
(
  '56400000-0000-0000-0000-000000000001', 'oripark',
  '56300000-0000-0000-0000-000000000001', 'TEST',
  '56100000-0000-0000-0000-000000000001',
  '56200000-0000-0000-0000-000000000001',
  '56000000-0000-0000-0000-000000000001'
),
(
  '56400000-0000-0000-0000-000000000002', 'manman',
  '56300000-0000-0000-0000-000000000002', 'TEST',
  '56100000-0000-0000-0000-000000000002',
  '56200000-0000-0000-0000-000000000002',
  '56000000-0000-0000-0000-000000000002'
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.post_plan
   WHERE id IN (
     '56400000-0000-0000-0000-000000000001',
     '56400000-0000-0000-0000-000000000002'
   )),
  2,
  'each store accepts a plan referencing only its own posting configuration'
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_plan (
      id, store, run_id, franchise
    ) VALUES (
      '56400000-0000-0000-0000-000000000003', 'manman',
      '56300000-0000-0000-0000-000000000001', 'TEST'
    );
    RAISE EXCEPTION 'cross-store Run reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('post_plan rejects a Run owned by another store');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_plan (
      id, store, franchise, template_id
    ) VALUES (
      '56400000-0000-0000-0000-000000000004', 'manman', 'TEST',
      '56100000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'cross-store template reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('post_plan rejects a template owned by another store');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_plan (
      id, store, franchise, banner_id
    ) VALUES (
      '56400000-0000-0000-0000-000000000005', 'manman', 'TEST',
      '56200000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'cross-store banner reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('post_plan rejects a banner owned by another store');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.post_plan (
      id, store, franchise, x_credential_id
    ) VALUES (
      '56400000-0000-0000-0000-000000000006', 'manman', 'TEST',
      '56000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'cross-store credential reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('post_plan rejects an X credential owned by another store');

SELECT lives_ok(
  $$INSERT INTO public.post_plan (
    id, store, run_id, franchise, template_id, banner_id, x_credential_id
  ) VALUES (
    '56400000-0000-0000-0000-000000000007', 'manman', NULL, 'TEST',
    NULL, NULL, NULL
  )$$,
  'nullable post_plan references remain valid'
);

INSERT INTO public.db_card (
  id, store, franchise, tag, card_name, grade, list_no
) VALUES
(
  '51000000-0000-0000-0000-000000000001', 'oripark',
  'Pokemon', 'TEST-O', 'Shared Store Card', 'PSA10', 'STORE-001'
),
(
  '51000000-0000-0000-0000-000000000002', 'manman',
  'Pokemon', 'TEST-M', 'Shared Store Card', 'PSA10', 'STORE-001'
);

SELECT is(
  (SELECT count(*)::INT FROM public.db_card
   WHERE card_name = 'Shared Store Card' AND list_no = 'STORE-001'),
  2,
  'the same db_card identity may exist once per store'
);

INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename, original_size_bytes,
  sha256, storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, unmatched_rows
) VALUES
(
  '52000000-0000-0000-0000-000000000001', 'oripark', DATE '2099-03-01',
  'applied', 'oripark-store.xlsx', 1, repeat('1', 64),
  'tests/oripark-store.xlsx', TRUE, TRUE, 1, 1, 1
),
(
  '52000000-0000-0000-0000-000000000002', 'manman', DATE '2099-03-01',
  'applied', 'manman-store.xlsx', 1, repeat('1', 64),
  'tests/manman-store.xlsx', TRUE, TRUE, 1, 1, 1
);

SELECT is(
  (SELECT count(*)::INT FROM public.order_list_import
   WHERE business_date = DATE '2099-03-01' AND sha256 = repeat('1', 64)),
  2,
  'the same workbook identity may exist once per store'
);

INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, image_url, demand, source_price,
  match_status
) VALUES
(
  '53000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001',
  'Pokemon', 'SHARED-EXCEL-ID', 'Pokemon', 2, repeat('2', 64),
  'Shared Store Card', 'PSA10', 'STORE-001',
  'https://example.com/oripark.png', 1, 100, 'unmatched'
),
(
  '53000000-0000-0000-0000-000000000002',
  '52000000-0000-0000-0000-000000000002',
  'Pokemon', 'SHARED-EXCEL-ID', 'Pokemon', 2, repeat('3', 64),
  'Shared Store Card', 'PSA10', 'STORE-001',
  'https://example.com/manman.png', 1, 100, 'unmatched'
);

DO $test$
BEGIN
  PERFORM public.resolve_order_list_item_mapping(
    '52000000-0000-0000-0000-000000000001',
    '53000000-0000-0000-0000-000000000001',
    '51000000-0000-0000-0000-000000000001'
  );
  PERFORM public.resolve_order_list_item_mapping(
    '52000000-0000-0000-0000-000000000002',
    '53000000-0000-0000-0000-000000000002',
    '51000000-0000-0000-0000-000000000002'
  );
END
$test$;
SELECT pass('legacy mapping RPC resolves both stores independently');

SELECT is(
  (SELECT count(*)::INT FROM public.excel_product_mapping
   WHERE franchise = 'Pokemon' AND excel_product_key = 'shared-excel-id'),
  2,
  'the same normalized Excel product ID has two store-owned mappings'
);

DO $test$
BEGIN
  BEGIN
    PERFORM public.resolve_order_list_item_mapping(
      '52000000-0000-0000-0000-000000000002',
      '53000000-0000-0000-0000-000000000002',
      '51000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'cross-store db_card mapping unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    NULL;
  END;
END
$test$;
SELECT pass('a MANMAN import cannot map to an Oripark db_card');

DO $test$
DECLARE
  v_oripark_status TEXT;
  v_manman_status TEXT;
BEGIN
  PERFORM public.resolve_order_list_review_changes(
    '52000000-0000-0000-0000-000000000002',
    '[]'::JSONB,
    '[]'::JSONB,
    jsonb_build_array(jsonb_build_object(
      'item_id', '53000000-0000-0000-0000-000000000002'
    )),
    TRUE
  );
  SELECT status INTO v_oripark_status
  FROM public.excel_product_mapping
  WHERE store = 'oripark' AND franchise = 'Pokemon'
    AND excel_product_key = 'shared-excel-id';
  SELECT status INTO v_manman_status
  FROM public.excel_product_mapping
  WHERE store = 'manman' AND franchise = 'Pokemon'
    AND excel_product_key = 'shared-excel-id';
  IF v_oripark_status <> 'active' OR v_manman_status <> 'disabled' THEN
    RAISE EXCEPTION 'store-local exclusion leaked: % / %',
      v_oripark_status, v_manman_status;
  END IF;
END
$test$;
SELECT pass('MANMAN exclusion does not disable the Oripark mapping');

DO $test$
BEGIN
  BEGIN
    UPDATE public.order_list_item
    SET mapping_id = (
          SELECT id FROM public.excel_product_mapping
          WHERE store = 'oripark' AND franchise = 'Pokemon'
            AND excel_product_key = 'shared-excel-id'
        ),
        db_card_id = '51000000-0000-0000-0000-000000000001',
        match_status = 'matched'
    WHERE id = '53000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'direct cross-store item reference unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('order_list_item trigger rejects direct cross-store references');
INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename, original_size_bytes,
  sha256, storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, unmatched_rows
) VALUES (
  '52000000-0000-0000-0000-000000000003', 'manman', DATE '2099-03-02',
  'applied', 'manman-new-card.xlsx', 1, repeat('4', 64),
  'tests/manman-new-card.xlsx', TRUE, TRUE, 1, 1, 1
);

INSERT INTO public.order_list_item (
  id, import_id, franchise, excel_product_id, sheet_name, sheet_row_number,
  row_hash, card_name, grade, list_no, image_url, demand, source_price,
  match_status
) VALUES (
  '53000000-0000-0000-0000-000000000003',
  '52000000-0000-0000-0000-000000000003',
  'Pokemon', 'MANMAN-NEW-CARD-ID', 'Pokemon', 2, repeat('5', 64),
  'MANMAN Store New Card', 'PSA10', 'STORE-NEW-001',
  'https://example.com/manman-new.png', 1, 200, 'unmatched'
);

DO $test$
DECLARE
  v_new_cards JSONB := jsonb_build_array(jsonb_build_object(
    'item_id', '53000000-0000-0000-0000-000000000003',
    'card_name', 'MANMAN Store New Card',
    'grade', 'PSA10',
    'list_no', 'STORE-NEW-001',
    'tag', 'TEST-NEW'
  ));
BEGIN
  PERFORM public.resolve_order_list_review_changes(
    '52000000-0000-0000-0000-000000000003',
    '[]'::JSONB, v_new_cards, '[]'::JSONB, FALSE
  );
  PERFORM public.resolve_order_list_review_changes(
    '52000000-0000-0000-0000-000000000003',
    '[]'::JSONB, v_new_cards, '[]'::JSONB, FALSE
  );
  IF (SELECT count(*) FROM public.db_card
      WHERE store = 'manman' AND card_name = 'MANMAN Store New Card'
        AND list_no = 'STORE-NEW-001') <> 1
    OR (SELECT count(*) FROM public.db_card
        WHERE store = 'oripark' AND card_name = 'MANMAN Store New Card'
          AND list_no = 'STORE-NEW-001') <> 0 THEN
    RAISE EXCEPTION 'new-card idempotency/store ownership failed';
  END IF;
END
$test$;
SELECT pass('new-card retry is idempotent and creates only a MANMAN card');

DO $test$
DECLARE
  v_oripark JSONB;
  v_manman JSONB;
BEGIN
  v_oripark := public.queue_order_list_import_resync(
    '52000000-0000-0000-0000-000000000001',
    '54000000-0000-0000-0000-000000000001', repeat('a', 64),
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  );
  v_manman := public.queue_order_list_import_resync(
    '52000000-0000-0000-0000-000000000003',
    '54000000-0000-0000-0000-000000000002', repeat('b', 64),
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  );
  IF v_oripark ->> 'action' <> 'start_job'
    OR v_manman ->> 'action' <> 'start_job' THEN
    RAISE EXCEPTION 'store-local resync queues were not claimed';
  END IF;
END
$test$;
SELECT pass('Oripark and MANMAN resync requests queue independently');

SELECT is(
  (SELECT count(*)::INT FROM public.order_list_import
   WHERE id IN (
     '52000000-0000-0000-0000-000000000001',
     '52000000-0000-0000-0000-000000000003'
   ) AND status = 'confirmed'),
  2,
  'one confirmed import may exist in each store'
);

INSERT INTO public.run (
  id, triggered_by, store, status, order_list_import_id,
  order_list_sync_request_id, order_list_sync_request_fingerprint
) VALUES
(
  '55000000-0000-0000-0000-000000000001', 'sql-store-isolation',
  'oripark', 'running', '52000000-0000-0000-0000-000000000001',
  '54000000-0000-0000-0000-000000000001', repeat('a', 64)
),
(
  '55000000-0000-0000-0000-000000000002', 'sql-store-isolation',
  'manman', 'running', '52000000-0000-0000-0000-000000000003',
  '54000000-0000-0000-0000-000000000002', repeat('b', 64)
);

UPDATE public.order_list_import
SET status = 'processing', processing_started_at = clock_timestamp()
WHERE id IN (
  '52000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000003'
);

SELECT is(
  (SELECT count(*)::INT FROM public.run
   WHERE id IN (
     '55000000-0000-0000-0000-000000000001',
     '55000000-0000-0000-0000-000000000002'
   ) AND status = 'running'),
  2,
  'one running sync Run may exist in each store'
);

SELECT is(
  (public.queue_order_list_import_resync(
    '52000000-0000-0000-0000-000000000001',
    '54000000-0000-0000-0000-000000000001', repeat('a', 64),
    '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
  ) ->> 'action'),
  'noop',
  'the same request ID and fingerprint replay without another Run'
);

DO $test$
BEGIN
  BEGIN
    PERFORM public.queue_order_list_import_resync(
      '52000000-0000-0000-0000-000000000001',
      '54000000-0000-0000-0000-000000000001', repeat('c', 64),
      '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, FALSE
    );
    RAISE EXCEPTION 'request fingerprint mismatch unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END
$test$;
SELECT pass('request ID replay rejects a different fingerprint');

SELECT ok(
  public.renew_order_list_sync_lease(
    '52000000-0000-0000-0000-000000000001',
    '55000000-0000-0000-0000-000000000001', clock_timestamp()
  ),
  'matching store/import/run renews the sync lease'
);

SELECT ok(
  NOT public.renew_order_list_sync_lease(
    '52000000-0000-0000-0000-000000000001',
    '55000000-0000-0000-0000-000000000002', clock_timestamp()
  ),
  'a MANMAN Run cannot renew an Oripark import lease'
);

SELECT lives_ok(
  $$SELECT public.finalize_order_list_sync(
    '52000000-0000-0000-0000-000000000003',
    '55000000-0000-0000-0000-000000000002', 1, 1, clock_timestamp()
  )$$,
  'MANMAN sync finalizes with its own fenced Run'
);

DO $test$
BEGIN
  IF (SELECT status FROM public.order_list_import
      WHERE id = '52000000-0000-0000-0000-000000000003') <> 'applied'
    OR (SELECT status FROM public.run
        WHERE id = '55000000-0000-0000-0000-000000000002') <> 'completed'
    OR (SELECT status FROM public.order_list_import
        WHERE id = '52000000-0000-0000-0000-000000000001') <> 'processing'
    OR (SELECT status FROM public.run
        WHERE id = '55000000-0000-0000-0000-000000000001') <> 'running' THEN
    RAISE EXCEPTION 'MANMAN finalize changed Oripark state';
  END IF;
END
$test$;
SELECT pass('MANMAN finalize leaves the Oripark sync untouched');

SELECT lives_ok(
  $$SELECT public.fail_order_list_sync(
    '52000000-0000-0000-0000-000000000001',
    '55000000-0000-0000-0000-000000000001',
    'expected SQL test failure', clock_timestamp()
  )$$,
  'Oripark sync fails with its own fenced Run'
);

DO $test$
BEGIN
  IF (SELECT status FROM public.order_list_import
      WHERE id = '52000000-0000-0000-0000-000000000001') <> 'failed'
    OR (SELECT status FROM public.run
        WHERE id = '55000000-0000-0000-0000-000000000001') <> 'failed'
    OR (SELECT status FROM public.order_list_import
        WHERE id = '52000000-0000-0000-0000-000000000003') <> 'applied' THEN
    RAISE EXCEPTION 'Oripark failure changed MANMAN state';
  END IF;
END
$test$;
SELECT pass('Oripark failure leaves the MANMAN result untouched');

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.run (
      id, triggered_by, store, status, order_list_import_id
    ) VALUES (
      '55000000-0000-0000-0000-000000000003', 'sql-store-isolation',
      'manman', 'completed', '52000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'cross-store run reference unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('database FK rejects a cross-store Run/import reference');

INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename, original_size_bytes,
  sha256, storage_path, persistence_complete, structural_valid,
  total_rows, valid_rows, confirmed_at, heartbeat_at
) VALUES
(
  '52000000-0000-0000-0000-000000000004', 'oripark', DATE '2099-03-04',
  'confirmed', 'oripark-stale.xlsx', 1, repeat('6', 64),
  'tests/oripark-stale.xlsx', TRUE, TRUE, 0, 0,
  clock_timestamp() - INTERVAL '3 hours', clock_timestamp() - INTERVAL '3 hours'
),
(
  '52000000-0000-0000-0000-000000000005', 'manman', DATE '2099-03-04',
  'confirmed', 'manman-stale.xlsx', 1, repeat('7', 64),
  'tests/manman-stale.xlsx', TRUE, TRUE, 0, 0,
  clock_timestamp() - INTERVAL '3 hours', clock_timestamp() - INTERVAL '3 hours'
);

SELECT is(
  public.recover_stale_order_list_imports_for_store(
    'manman', clock_timestamp() - INTERVAL '2 hours'
  ),
  1,
  'store-scoped recovery handles only the stale MANMAN import'
);

DO $test$
BEGIN
  IF (SELECT status FROM public.order_list_import
      WHERE id = '52000000-0000-0000-0000-000000000005') <> 'failed'
    OR (SELECT status FROM public.order_list_import
        WHERE id = '52000000-0000-0000-0000-000000000004') <> 'confirmed' THEN
    RAISE EXCEPTION 'store-scoped recovery leaked across stores';
  END IF;
END
$test$;
SELECT pass('MANMAN stale recovery leaves Oripark active');

SELECT * FROM finish();
ROLLBACK;
