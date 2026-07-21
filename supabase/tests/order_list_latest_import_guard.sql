\set ON_ERROR_STOP on
BEGIN;
SELECT plan(8);

-- Keep this test independent from seed or a previously interrupted local run.
UPDATE public.run
SET status = 'completed',
    completed_at = coalesce(completed_at, clock_timestamp())
WHERE status = 'running';

UPDATE public.order_list_import
SET status = 'applied',
    heartbeat_at = NULL
WHERE status IN ('confirmed', 'processing');

SELECT has_trigger(
  'public',
  'order_list_import',
  'trg_reject_stale_order_list_import_activation',
  'stale order-list activation is protected at the database boundary'
);

-- A newer, valid and fully persisted workbook in the same store must make an
-- older MANMAN import impossible to activate.
INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename,
  original_size_bytes, sha256, storage_path,
  persistence_complete, structural_valid, created_at
) VALUES
(
  '57000000-0000-4000-8000-000000000001',
  'manman',
  DATE '2099-07-15',
  'parsed',
  'manman-old.xlsx',
  1,
  repeat('1', 64),
  'tests/latest-import-guard/manman-old.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-15 09:00:00+09'
),
(
  '57000000-0000-4000-8000-000000000002',
  'manman',
  DATE '2099-07-20',
  'parsed',
  'manman-latest.xlsx',
  1,
  repeat('2', 64),
  'tests/latest-import-guard/manman-latest.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-20 09:00:00+09'
);

DO $test$
BEGIN
  BEGIN
    UPDATE public.order_list_import
    SET status = 'confirmed'
    WHERE id = '57000000-0000-4000-8000-000000000001';

    RAISE EXCEPTION 'older MANMAN import unexpectedly became confirmed';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END
$test$;
SELECT pass('an older valid MANMAN import is rejected');

SELECT is(
  (
    SELECT status
    FROM public.order_list_import
    WHERE id = '57000000-0000-4000-8000-000000000001'
  ),
  'parsed',
  'a rejected older MANMAN import remains parsed'
);

SELECT lives_ok(
  $$
    UPDATE public.order_list_import
    SET status = 'confirmed'
    WHERE id = '57000000-0000-4000-8000-000000000002'
  $$,
  'the latest valid MANMAN import may be confirmed'
);

SELECT is(
  (
    SELECT status
    FROM public.order_list_import
    WHERE id = '57000000-0000-4000-8000-000000000002'
  ),
  'confirmed',
  'the latest MANMAN import reaches confirmed'
);

UPDATE public.order_list_import
SET status = 'applied'
WHERE id = '57000000-0000-4000-8000-000000000002';

DELETE FROM public.order_list_import
WHERE id IN (
  '57000000-0000-4000-8000-000000000001',
  '57000000-0000-4000-8000-000000000002'
);

-- A newer workbook owned by another store must not affect MANMAN.
INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename,
  original_size_bytes, sha256, storage_path,
  persistence_complete, structural_valid, created_at
) VALUES
(
  '57000000-0000-4000-8000-000000000003',
  'manman',
  DATE '2099-07-10',
  'parsed',
  'manman-store-scope-target.xlsx',
  1,
  repeat('3', 64),
  'tests/latest-import-guard/manman-store-scope-target.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-10 09:00:00+09'
),
(
  '57000000-0000-4000-8000-000000000004',
  'oripark',
  DATE '2099-07-31',
  'parsed',
  'oripark-newer.xlsx',
  1,
  repeat('4', 64),
  'tests/latest-import-guard/oripark-newer.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-31 09:00:00+09'
);

SELECT lives_ok(
  $$
    UPDATE public.order_list_import
    SET status = 'confirmed'
    WHERE id = '57000000-0000-4000-8000-000000000003'
  $$,
  'a newer import in another store does not block MANMAN'
);

UPDATE public.order_list_import
SET status = 'applied'
WHERE id = '57000000-0000-4000-8000-000000000003';

DELETE FROM public.order_list_import
WHERE id IN (
  '57000000-0000-4000-8000-000000000003',
  '57000000-0000-4000-8000-000000000004'
);

-- A structurally invalid workbook is not an eligible latest import.
INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename,
  original_size_bytes, sha256, storage_path,
  persistence_complete, structural_valid, created_at
) VALUES
(
  '57000000-0000-4000-8000-000000000005',
  'manman',
  DATE '2099-07-10',
  'parsed',
  'manman-invalid-target.xlsx',
  1,
  repeat('5', 64),
  'tests/latest-import-guard/manman-invalid-target.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-10 09:00:00+09'
),
(
  '57000000-0000-4000-8000-000000000006',
  'manman',
  DATE '2099-07-31',
  'parsed',
  'manman-structurally-invalid.xlsx',
  1,
  repeat('6', 64),
  'tests/latest-import-guard/manman-structurally-invalid.xlsx',
  TRUE,
  FALSE,
  TIMESTAMPTZ '2099-07-31 09:00:00+09'
);

SELECT lives_ok(
  $$
    UPDATE public.order_list_import
    SET status = 'confirmed'
    WHERE id = '57000000-0000-4000-8000-000000000005'
  $$,
  'a newer structurally invalid import does not block MANMAN'
);

UPDATE public.order_list_import
SET status = 'applied'
WHERE id = '57000000-0000-4000-8000-000000000005';

DELETE FROM public.order_list_import
WHERE id IN (
  '57000000-0000-4000-8000-000000000005',
  '57000000-0000-4000-8000-000000000006'
);

-- A workbook whose rows were not fully persisted is not eligible either.
INSERT INTO public.order_list_import (
  id, store, business_date, status, original_filename,
  original_size_bytes, sha256, storage_path,
  persistence_complete, structural_valid, created_at
) VALUES
(
  '57000000-0000-4000-8000-000000000007',
  'manman',
  DATE '2099-07-10',
  'parsed',
  'manman-incomplete-target.xlsx',
  1,
  repeat('7', 64),
  'tests/latest-import-guard/manman-incomplete-target.xlsx',
  TRUE,
  TRUE,
  TIMESTAMPTZ '2099-07-10 09:00:00+09'
),
(
  '57000000-0000-4000-8000-000000000008',
  'manman',
  DATE '2099-07-31',
  'parsed',
  'manman-persistence-incomplete.xlsx',
  1,
  repeat('8', 64),
  'tests/latest-import-guard/manman-persistence-incomplete.xlsx',
  FALSE,
  TRUE,
  TIMESTAMPTZ '2099-07-31 09:00:00+09'
);

SELECT lives_ok(
  $$
    UPDATE public.order_list_import
    SET status = 'confirmed'
    WHERE id = '57000000-0000-4000-8000-000000000007'
  $$,
  'a newer persistence-incomplete import does not block MANMAN'
);

SELECT * FROM finish();
ROLLBACK;
