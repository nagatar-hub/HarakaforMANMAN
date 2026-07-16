-- One-time, idempotent transfer of order-list products registered in Oripark
-- import d28c35c0-7a01-4fc9-acb8-f1d0d3dd469b to the Manman store scope.
--
-- This intentionally copies only db_card and excel_product_mapping. It does
-- not copy prices, prepared_card, raw_import, runs, or generated pages.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

SELECT pg_advisory_xact_lock(
  hashtextextended(
    'haraka:order-list-product-transfer:oripark:manman:d28c35c0-7a01-4fc9-acb8-f1d0d3dd469b',
    0
  )
);

CREATE TEMP TABLE transfer_source ON COMMIT DROP AS
SELECT
  mapping.franchise,
  mapping.excel_product_id,
  mapping.excel_product_key,
  card.tag,
  card.card_name,
  card.grade,
  card.list_no,
  card.image_url,
  card.alt_image_url,
  card.rarity_icon,
  card.image_status
FROM public.excel_product_mapping AS mapping
JOIN public.db_card AS card
  ON card.store = 'oripark'
 AND card.id = mapping.db_card_id
WHERE mapping.store = 'oripark'
  AND mapping.first_seen_import_id = 'd28c35c0-7a01-4fc9-acb8-f1d0d3dd469b'::UUID
  AND mapping.match_method = 'manual';

CREATE UNIQUE INDEX transfer_source_excel_identity
  ON transfer_source (franchise, excel_product_key);

CREATE UNIQUE INDEX transfer_source_card_identity
  ON transfer_source (franchise, card_name, grade, list_no);

CREATE TEMP TABLE transfer_state (
  initial_same_count INTEGER NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  source_count INTEGER;
  initial_same_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_list_import
    WHERE id = 'd28c35c0-7a01-4fc9-acb8-f1d0d3dd469b'::UUID
      AND store = 'oripark'
      AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'source Oripark import is missing or no longer applied';
  END IF;

  SELECT count(*)::INTEGER INTO source_count FROM transfer_source;
  IF source_count <> 68 THEN
    RAISE EXCEPTION 'source product count changed: expected 68, got %', source_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM transfer_source
    WHERE nullif(btrim(tag), '') IS NULL
       OR nullif(btrim(image_url), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'source contains a product without a tag or primary image';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.run
    WHERE store = 'manman' AND status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'a Manman run is active';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_list_import
    WHERE store = 'manman' AND status NOT IN ('applied', 'failed')
  ) THEN
    RAISE EXCEPTION 'a Manman order-list import is active';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transfer_source AS source
    JOIN public.excel_product_mapping AS mapping
      ON mapping.store = 'manman'
     AND mapping.franchise = source.franchise
     AND mapping.excel_product_key = source.excel_product_key
    LEFT JOIN public.db_card AS card
      ON card.store = 'manman'
     AND card.id = mapping.db_card_id
    WHERE card.id IS NULL
       OR card.card_name IS DISTINCT FROM source.card_name
       OR card.grade IS DISTINCT FROM source.grade
       OR card.list_no IS DISTINCT FROM source.list_no
  ) THEN
    RAISE EXCEPTION 'a Manman Excel mapping points to a different product';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM transfer_source AS source
    JOIN public.db_card AS card
      ON card.store = 'manman'
     AND card.franchise = source.franchise
     AND card.card_name = source.card_name
     AND card.grade = source.grade
     AND card.list_no = source.list_no
    LEFT JOIN public.excel_product_mapping AS mapping
      ON mapping.store = 'manman'
     AND mapping.franchise = source.franchise
     AND mapping.excel_product_key = source.excel_product_key
     AND mapping.db_card_id = card.id
    WHERE mapping.id IS NULL
  ) THEN
    RAISE EXCEPTION 'a Manman product exists without the expected Excel mapping';
  END IF;

  SELECT count(*)::INTEGER INTO initial_same_count
  FROM transfer_source AS source
  JOIN public.excel_product_mapping AS mapping
    ON mapping.store = 'manman'
   AND mapping.franchise = source.franchise
   AND mapping.excel_product_key = source.excel_product_key
  JOIN public.db_card AS card
    ON card.store = 'manman'
   AND card.id = mapping.db_card_id
   AND card.card_name = source.card_name
   AND card.grade = source.grade
   AND card.list_no = source.list_no;

  IF initial_same_count NOT IN (0, 68) THEN
    RAISE EXCEPTION 'partial prior transfer detected: % of 68 rows', initial_same_count;
  END IF;

  INSERT INTO transfer_state (initial_same_count) VALUES (initial_same_count);
END;
$$;

CREATE TEMP TABLE transfer_inserted_cards (
  id UUID PRIMARY KEY
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.db_card (
    store,
    franchise,
    tag,
    card_name,
    grade,
    list_no,
    image_url,
    alt_image_url,
    rarity_icon,
    image_status
  )
  SELECT
    'manman',
    source.franchise,
    source.tag,
    source.card_name,
    source.grade,
    source.list_no,
    source.image_url,
    source.alt_image_url,
    source.rarity_icon,
    source.image_status
  FROM transfer_source AS source
  WHERE (SELECT initial_same_count FROM transfer_state) = 0
  ON CONFLICT (store, franchise, card_name, grade, list_no) DO NOTHING
  RETURNING id
)
INSERT INTO transfer_inserted_cards (id)
SELECT id FROM inserted;

CREATE TEMP TABLE transfer_targets ON COMMIT DROP AS
SELECT
  source.franchise,
  source.excel_product_id,
  source.excel_product_key,
  source.card_name,
  source.grade,
  source.list_no,
  card.id AS target_card_id
FROM transfer_source AS source
JOIN public.db_card AS card
  ON card.store = 'manman'
 AND card.franchise = source.franchise
 AND card.card_name = source.card_name
 AND card.grade = source.grade
 AND card.list_no = source.list_no;

CREATE UNIQUE INDEX transfer_targets_excel_identity
  ON transfer_targets (franchise, excel_product_key);

CREATE TEMP TABLE transfer_inserted_mappings (
  id UUID PRIMARY KEY
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.excel_product_mapping (
    store,
    franchise,
    excel_product_id,
    db_card_id,
    status,
    match_method,
    first_seen_import_id,
    last_seen_import_id,
    confirmed_by,
    confirmed_at
  )
  SELECT
    'manman',
    target.franchise,
    target.excel_product_id,
    target.target_card_id,
    'active',
    'manual',
    NULL,
    NULL,
    'oripark-transfer:d28c35c0-7a01-4fc9-acb8-f1d0d3dd469b',
    now()
  FROM transfer_targets AS target
  WHERE (SELECT initial_same_count FROM transfer_state) = 0
  ON CONFLICT (store, franchise, excel_product_key) DO NOTHING
  RETURNING id
)
INSERT INTO transfer_inserted_mappings (id)
SELECT id FROM inserted;

DO $$
DECLARE
  initial_same_count INTEGER;
  inserted_card_count INTEGER;
  inserted_mapping_count INTEGER;
  final_same_count INTEGER;
BEGIN
  SELECT state.initial_same_count INTO initial_same_count FROM transfer_state AS state;
  SELECT count(*)::INTEGER INTO inserted_card_count FROM transfer_inserted_cards;
  SELECT count(*)::INTEGER INTO inserted_mapping_count FROM transfer_inserted_mappings;

  IF initial_same_count = 0
     AND (inserted_card_count <> 68 OR inserted_mapping_count <> 68) THEN
    RAISE EXCEPTION
      'concurrent change detected: inserted cards %, mappings % (expected 68 each)',
      inserted_card_count,
      inserted_mapping_count;
  END IF;

  IF initial_same_count = 68
     AND (inserted_card_count <> 0 OR inserted_mapping_count <> 0) THEN
    RAISE EXCEPTION 'idempotent replay unexpectedly inserted rows';
  END IF;

  SELECT count(*)::INTEGER INTO final_same_count
  FROM transfer_source AS source
  JOIN public.excel_product_mapping AS mapping
    ON mapping.store = 'manman'
   AND mapping.franchise = source.franchise
   AND mapping.excel_product_key = source.excel_product_key
   AND mapping.status = 'active'
  JOIN public.db_card AS card
    ON card.store = 'manman'
   AND card.id = mapping.db_card_id
   AND card.card_name = source.card_name
   AND card.grade = source.grade
   AND card.list_no = source.list_no;

  IF final_same_count <> 68 THEN
    RAISE EXCEPTION 'postcondition failed: % of 68 mappings are valid', final_same_count;
  END IF;

  RAISE NOTICE
    'Oripark to Manman transfer verified: 68 products, 68 mappings, initial same %',
    initial_same_count;
END;
$$;

COMMIT;

-- Rollback, if required before any Manman sync consumes these rows:
-- 1. Delete excel_product_mapping rows whose confirmed_by equals the marker above.
-- 2. Delete only their db_card rows that have no prepared_card/order-list references.
