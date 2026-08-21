BEGIN;

-- Re-importing the same workbook is valid when a new parser version supports
-- additional franchise sheets. Keep same-version uploads idempotent while
-- allowing the v1 source file to be processed once by v2.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_list_import
    WHERE parser_version IS NULL OR btrim(parser_version) = ''
  ) THEN
    RAISE EXCEPTION 'order_list_import.parser_version must be populated before changing duplicate identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.order_list_import'::regclass
      AND attname = 'parser_version'
      AND attnotnull
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'order_list_import.parser_version must remain NOT NULL';
  END IF;
END;
$$;

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_file_per_store;

ALTER TABLE public.order_list_import
  ADD CONSTRAINT uix_order_list_import_file_per_store
  UNIQUE (store, business_date, sha256, parser_version);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.order_list_import'::regclass
      AND conname = 'uix_order_list_import_file_per_store'
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (store, business_date, sha256, parser_version)'
  ) THEN
    RAISE EXCEPTION 'parser-version duplicate identity constraint was not installed';
  END IF;
END;
$$;

COMMIT;
