-- Excel オーダーリスト取込と Haraka DB 商品対応を永続化する。
-- 原本は private Storage bucket に保存し、公開 policy は作成しない。

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'order-list-imports',
  'order-list-imports',
  FALSE,
  15728640,
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.order_list_import (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date         DATE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'parsed'
                        CHECK (status IN ('parsed', 'confirmed', 'processing', 'applied', 'failed')),
  original_filename     TEXT NOT NULL CHECK (btrim(original_filename) <> ''),
  original_mime_type    TEXT,
  original_size_bytes   BIGINT NOT NULL CHECK (original_size_bytes >= 0),
  sha256                TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  storage_bucket        TEXT NOT NULL DEFAULT 'order-list-imports'
                        CHECK (btrim(storage_bucket) <> ''),
  storage_path          TEXT NOT NULL CHECK (btrim(storage_path) <> ''),
  parser_version        TEXT NOT NULL DEFAULT '1',
  persistence_complete  BOOLEAN NOT NULL DEFAULT FALSE,
  structural_valid      BOOLEAN NOT NULL DEFAULT FALSE,
  sheet_counts          JSONB NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(sheet_counts) = 'object'),
  applied_summary       JSONB CHECK (
                          applied_summary IS NULL OR jsonb_typeof(applied_summary) = 'object'),
  total_rows            INT NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows            INT NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  matched_rows          INT NOT NULL DEFAULT 0 CHECK (matched_rows >= 0),
  unmatched_rows        INT NOT NULL DEFAULT 0 CHECK (unmatched_rows >= 0),
  ambiguous_rows        INT NOT NULL DEFAULT 0 CHECK (ambiguous_rows >= 0),
  invalid_rows          INT NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  duplicate_rows        INT NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  error_summary         JSONB NOT NULL DEFAULT '{"issues":[]}'::jsonb
                        CHECK (jsonb_typeof(error_summary) = 'object'),
  uploaded_by           TEXT,
  confirmed_by          TEXT,
  confirmed_at          TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  heartbeat_at          TIMESTAMPTZ,
  activated_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  failure_message       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uix_order_list_import_file UNIQUE (business_date, sha256)
);

CREATE INDEX IF NOT EXISTS idx_order_list_import_business_date
  ON public.order_list_import (business_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_list_import_status
  ON public.order_list_import (status, created_at DESC);

-- Only one workbook may be queued or processing at a time. This also closes
-- the race between two API instances confirming different imports.
CREATE UNIQUE INDEX IF NOT EXISTS uix_order_list_import_single_active
  ON public.order_list_import ((1))
  WHERE status IN ('confirmed', 'processing');
CREATE TABLE IF NOT EXISTS public.excel_product_mapping (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise            TEXT NOT NULL
                       CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  excel_product_id     TEXT NOT NULL CHECK (btrim(excel_product_id) <> ''),
  excel_product_key    TEXT GENERATED ALWAYS AS (
                         lower(btrim(regexp_replace(
                           normalize(excel_product_id, NFKC),
                           '[[:space:]]+', ' ', 'g'
                         )))
                       ) STORED,
  db_card_id           UUID REFERENCES public.db_card(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'disabled')),
  match_method         TEXT
                       CHECK (match_method IS NULL OR match_method IN (
                         'existing_mapping', 'exact_image', 'exact_identity', 'manual'
                       )),
  first_seen_import_id UUID REFERENCES public.order_list_import(id) ON DELETE SET NULL,
  last_seen_import_id  UUID REFERENCES public.order_list_import(id) ON DELETE SET NULL,
  confirmed_by         TEXT,
  confirmed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uix_excel_product_mapping_identity UNIQUE (franchise, excel_product_key)
);

CREATE INDEX IF NOT EXISTS idx_excel_product_mapping_db_card
  ON public.excel_product_mapping (db_card_id)
  WHERE db_card_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_excel_product_mapping_status
  ON public.excel_product_mapping (status, franchise);

CREATE TABLE IF NOT EXISTS public.order_list_item (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         UUID NOT NULL
                    REFERENCES public.order_list_import(id) ON DELETE CASCADE,
  franchise         TEXT NOT NULL
                    CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  excel_product_id  TEXT NOT NULL,
  sheet_name        TEXT NOT NULL CHECK (btrim(sheet_name) <> ''),
  sheet_row_number  INT NOT NULL CHECK (sheet_row_number >= 1),
  row_hash          TEXT NOT NULL CHECK (row_hash ~ '^[0-9a-fA-F]{64}$'),
  card_name         TEXT NOT NULL,
  grade             TEXT,
  expansion         TEXT,
  list_no           TEXT,
  rarity            TEXT,
  image_url         TEXT,
  demand            INT CHECK (demand IS NULL OR demand >= 0),
  source_price      NUMERIC CHECK (source_price IS NULL OR source_price >= 0),
  raw_row           JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_issues JSONB NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(validation_issues) = 'array'),
  mapping_id        UUID REFERENCES public.excel_product_mapping(id) ON DELETE SET NULL,
  db_card_id        UUID REFERENCES public.db_card(id) ON DELETE SET NULL,
  match_status      TEXT NOT NULL DEFAULT 'unmatched'
                    CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'invalid')),
  match_method      TEXT
                    CHECK (match_method IS NULL OR match_method IN (
                      'existing_mapping', 'exact_image', 'exact_identity', 'manual'
                    )),
  match_candidates  JSONB NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(match_candidates) = 'array'),
  match_note        TEXT,
  matched_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uix_order_list_item_sheet_row
    UNIQUE (import_id, sheet_name, sheet_row_number),
  -- db_card 削除時の SET NULL を許容しつつ、不一致行の誤紐付けを防ぐ。
  CONSTRAINT chk_order_list_item_db_card_status
    CHECK (db_card_id IS NULL OR match_status = 'matched')
);

CREATE INDEX IF NOT EXISTS idx_order_list_item_import
  ON public.order_list_item (import_id, franchise, sheet_row_number);

CREATE INDEX IF NOT EXISTS idx_order_list_item_external_identity
  ON public.order_list_item (franchise, excel_product_id);

CREATE INDEX IF NOT EXISTS idx_order_list_item_match_status
  ON public.order_list_item (import_id, match_status);

CREATE INDEX IF NOT EXISTS idx_order_list_item_mapping
  ON public.order_list_item (mapping_id)
  WHERE mapping_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_list_item_db_card
  ON public.order_list_item (db_card_id)
  WHERE db_card_id IS NOT NULL;

ALTER TABLE public.run
  ADD COLUMN IF NOT EXISTS order_list_import_id UUID
    REFERENCES public.order_list_import(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_run_order_list_import
  ON public.run (order_list_import_id)
  WHERE order_list_import_id IS NOT NULL;
-- Sync and Generate both claim a run by setting status=running. A database
-- uniqueness guard closes the API-side TOCTOU window across both job types.
CREATE UNIQUE INDEX IF NOT EXISTS uix_run_single_running
  ON public.run ((1))
  WHERE status = 'running';


ALTER TABLE public.raw_import
  ADD COLUMN IF NOT EXISTS order_list_item_id UUID
    REFERENCES public.order_list_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excel_product_id TEXT,
  ADD COLUMN IF NOT EXISTS db_card_id UUID
    REFERENCES public.db_card(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_price NUMERIC,
  ADD COLUMN IF NOT EXISTS price_source TEXT NOT NULL DEFAULT 'kecak';

ALTER TABLE public.prepared_card
  ADD COLUMN IF NOT EXISTS order_list_item_id UUID
    REFERENCES public.order_list_item(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS excel_product_id TEXT,
  ADD COLUMN IF NOT EXISTS db_card_id UUID
    REFERENCES public.db_card(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_source TEXT NOT NULL DEFAULT 'kecak',
  ADD COLUMN IF NOT EXISTS price_source_date DATE;

-- ALTER TABLE ... ADD CONSTRAINT には IF NOT EXISTS がないため、名前で存在確認する。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_raw_import_source_price'
      AND conrelid = 'public.raw_import'::regclass
  ) THEN
    ALTER TABLE public.raw_import
      ADD CONSTRAINT chk_raw_import_source_price
      CHECK (source_price IS NULL OR source_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_raw_import_price_source'
      AND conrelid = 'public.raw_import'::regclass
  ) THEN
    ALTER TABLE public.raw_import
      ADD CONSTRAINT chk_raw_import_price_source
      CHECK (price_source IN ('order_list', 'kecak', 'spectre', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_prepared_card_price_source'
      AND conrelid = 'public.prepared_card'::regclass
  ) THEN
    ALTER TABLE public.prepared_card
      ADD CONSTRAINT chk_prepared_card_price_source
      CHECK (price_source IN ('order_list', 'kecak', 'spectre', 'manual'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_raw_import_order_list_item
  ON public.raw_import (order_list_item_id)
  WHERE order_list_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_import_excel_product
  ON public.raw_import (franchise, excel_product_id)
  WHERE excel_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prepared_card_order_list_item
  ON public.prepared_card (order_list_item_id)
  WHERE order_list_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prepared_card_excel_product
  ON public.prepared_card (franchise, excel_product_id)
  WHERE excel_product_id IS NOT NULL;
-- Complete the run and activate its workbook in one database transaction.
CREATE OR REPLACE FUNCTION public.finalize_order_list_sync(
  p_import_id UUID,
  p_run_id UUID,
  p_total_prepared INT,
  p_total_pages INT,
  p_completed_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.order_list_import
  SET status = 'applied',
      applied_summary = jsonb_build_object(
        'total', total_rows,
        'matched', matched_rows,
        'ambiguous', ambiguous_rows,
        'unmatched', unmatched_rows,
        'invalid', invalid_rows,
        'by_franchise', sheet_counts
      ),
      activated_at = p_completed_at,
      failed_at = NULL,
      failure_message = NULL,
      heartbeat_at = NULL,
      updated_at = p_completed_at
  WHERE id = p_import_id
    AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import is not processing: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.run
  SET total_prepared = p_total_prepared,
      total_pages = p_total_pages,
      plan_done_at = p_completed_at,
      status = 'completed',
      completed_at = p_completed_at
  WHERE id = p_run_id
    AND order_list_import_id = p_import_id
    AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run is not running for import: % / %', p_run_id, p_import_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_list_sync(UUID, UUID, INT, INT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_order_list_sync(UUID, UUID, INT, INT, TIMESTAMPTZ)
  TO service_role;

-- Fail the run and its workbook atomically so a partial cleanup cannot leave
-- an orphan running run that blocks the next execution.
CREATE OR REPLACE FUNCTION public.fail_order_list_sync(
  p_import_id UUID,
  p_run_id UUID,
  p_failure_message TEXT,
  p_failed_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_status TEXT;
  v_run_status TEXT;
BEGIN
  SELECT status
  INTO v_import_status
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_import_status <> 'processing' THEN
    RAISE EXCEPTION 'order_list_import is not processing: % / %', p_import_id, v_import_status
      USING ERRCODE = '55000';
  END IF;

  SELECT status
  INTO v_run_status
  FROM public.run
  WHERE id = p_run_id
    AND order_list_import_id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found for import: % / %', p_run_id, p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run_status <> 'running' THEN
    RAISE EXCEPTION 'run is not running: % / %', p_run_id, v_run_status
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.run
  SET status = 'failed',
      error_message = p_failure_message,
      completed_at = p_failed_at
  WHERE id = p_run_id;

  UPDATE public.order_list_import
  SET status = 'failed',
      failed_at = p_failed_at,
      failure_message = p_failure_message,
      heartbeat_at = NULL,
      updated_at = p_failed_at
  WHERE id = p_import_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_order_list_sync(UUID, UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_order_list_sync(UUID, UUID, TEXT, TIMESTAMPTZ)
  TO service_role;

ALTER TABLE public.order_list_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_list_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.excel_product_mapping ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.order_list_import, public.order_list_item, public.excel_product_mapping
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.order_list_import, public.order_list_item, public.excel_product_mapping
  TO service_role;

-- Resolve one staged item and its reusable product mapping under an import-row lock.
CREATE OR REPLACE FUNCTION public.resolve_order_list_item_mapping(
  p_import_id UUID,
  p_item_id UUID,
  p_db_card_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_status TEXT;
  v_structural_valid BOOLEAN;
  v_persistence_complete BOOLEAN;
  v_item public.order_list_item%ROWTYPE;
  v_db_card public.db_card%ROWTYPE;
  v_mapping public.excel_product_mapping%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT status, structural_valid, persistence_complete
  INTO v_import_status, v_structural_valid, v_persistence_complete
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_import_status IN ('confirmed', 'processing') THEN
    RAISE EXCEPTION 'order_list_import cannot be edited while %', v_import_status
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_structural_valid OR NOT v_persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;


  SELECT *
  INTO v_item
  FROM public.order_list_item
  WHERE id = p_item_id
    AND import_id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_item not found: %', p_item_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_item.match_status = 'invalid' THEN
    RAISE EXCEPTION 'invalid order_list_item cannot be mapped: %', p_item_id
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_db_card
  FROM public.db_card
  WHERE id = p_db_card_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'db_card not found: %', p_db_card_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_db_card.franchise <> v_item.franchise THEN
    RAISE EXCEPTION 'franchise mismatch'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.excel_product_mapping (
    franchise,
    excel_product_id,
    db_card_id,
    status,
    match_method,
    first_seen_import_id,
    last_seen_import_id,
    confirmed_at,
    confirmed_by,
    updated_at
  )
  VALUES (
    v_item.franchise,
    v_item.excel_product_id,
    v_db_card.id,
    'active',
    'manual',
    p_import_id,
    p_import_id,
    v_now,
    'web-ui',
    v_now
  )
  ON CONFLICT (franchise, excel_product_key)
  DO UPDATE SET
    db_card_id = EXCLUDED.db_card_id,
    status = 'active',
    match_method = 'manual',
    last_seen_import_id = p_import_id,
    confirmed_at = v_now,
    confirmed_by = 'web-ui',
    updated_at = v_now
  RETURNING * INTO v_mapping;

  UPDATE public.order_list_item
  SET mapping_id = v_mapping.id,
      db_card_id = v_db_card.id,
      match_status = 'matched',
      match_method = 'manual',
      match_note = CASE WHEN v_import_status = 'applied'
        THEN '反映後に確定した対応です。次回取込から使用し、過去の出力には遡及しません'
        ELSE NULL END,
      match_candidates = jsonb_build_array(v_db_card.id),
      matched_at = v_now,
      updated_at = v_now
  WHERE id = v_item.id;
  -- Keep current review counters in this transaction. The immutable
  -- activation-time snapshot is stored by finalize_order_list_sync.
    WITH per_franchise AS (
      SELECT
        franchise,
        count(*)::INT AS total,
        count(*) FILTER (WHERE match_status = 'matched')::INT AS matched,
        count(*) FILTER (WHERE match_status = 'ambiguous')::INT AS ambiguous,
        count(*) FILTER (WHERE match_status = 'unmatched')::INT AS unmatched,
        count(*) FILTER (WHERE match_status = 'invalid')::INT AS invalid
      FROM public.order_list_item
      WHERE import_id = p_import_id
      GROUP BY franchise
    ), aggregate_counts AS (
      SELECT
        coalesce(sum(total), 0)::INT AS total,
        coalesce(sum(matched), 0)::INT AS matched,
        coalesce(sum(ambiguous), 0)::INT AS ambiguous,
        coalesce(sum(unmatched), 0)::INT AS unmatched,
        coalesce(sum(invalid), 0)::INT AS invalid,
        jsonb_build_object(
          'Pokemon', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0),
          'ONE PIECE', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0),
          'YU-GI-OH!', jsonb_build_object('total', 0, 'matched', 0, 'ambiguous', 0, 'unmatched', 0, 'invalid', 0)
        ) || coalesce(jsonb_object_agg(
          franchise,
          jsonb_build_object(
            'total', total,
            'matched', matched,
            'ambiguous', ambiguous,
            'unmatched', unmatched,
            'invalid', invalid
          )
        ), '{}'::jsonb) AS sheet_counts
      FROM per_franchise
    )
    UPDATE public.order_list_import AS target
    SET sheet_counts = counts.sheet_counts,
        total_rows = counts.total,
        matched_rows = counts.matched,
        ambiguous_rows = counts.ambiguous,
        unmatched_rows = counts.unmatched,
        invalid_rows = counts.invalid,
        valid_rows = counts.matched + counts.ambiguous + counts.unmatched,
        updated_at = v_now
    FROM aggregate_counts AS counts
    WHERE target.id = p_import_id;


  RETURN jsonb_build_object(
    'item_id', v_item.id,
    'mapping', to_jsonb(v_mapping),
    'db_card', jsonb_build_object(
      'id', v_db_card.id,
      'franchise', v_db_card.franchise,
      'tag', v_db_card.tag,
      'card_name', v_db_card.card_name,
      'grade', v_db_card.grade,
      'list_no', v_db_card.list_no
    ),
    'applies_from_next_import', v_import_status = 'applied'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_list_item_mapping(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_item_mapping(UUID, UUID, UUID)
  TO service_role;

-- Resolve all UI selections in one transaction. The review screen keeps these
-- choices in browser state until the operator presses the final reflect button.
CREATE OR REPLACE FUNCTION public.resolve_order_list_item_mappings(
  p_import_id UUID,
  p_mappings JSONB,
  p_allow_unresolved BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_status TEXT;
  v_structural_valid BOOLEAN;
  v_persistence_complete BOOLEAN;
  v_entry JSONB;
  v_item_id UUID;
  v_db_card_id UUID;
  v_seen_item_ids UUID[] := ARRAY[]::UUID[];
  v_results JSONB := '[]'::JSONB;
  v_unselected_count INT;
  v_invalid_count INT;
BEGIN
  SELECT status, structural_valid, persistence_complete
  INTO v_import_status, v_structural_valid, v_persistence_complete
  FROM public.order_list_import
  WHERE id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_list_import not found: %', p_import_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_import_status NOT IN ('parsed', 'failed', 'applied') THEN
    RAISE EXCEPTION 'order_list_import cannot be edited while %', v_import_status
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_structural_valid OR NOT v_persistence_complete THEN
    RAISE EXCEPTION 'order_list_import is not safely persisted: %', p_import_id
      USING ERRCODE = '55000';
  END IF;

  p_mappings := coalesce(p_mappings, '[]'::JSONB);
  IF jsonb_typeof(p_mappings) <> 'array' THEN
    RAISE EXCEPTION 'mappings must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_mappings) > 1000 THEN
    RAISE EXCEPTION 'too many mappings: %', jsonb_array_length(p_mappings)
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_mappings)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
      OR nullif(btrim(v_entry ->> 'item_id'), '') IS NULL
      OR nullif(btrim(v_entry ->> 'db_card_id'), '') IS NULL THEN
      RAISE EXCEPTION 'each mapping requires item_id and db_card_id'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_item_id := (v_entry ->> 'item_id')::UUID;
      v_db_card_id := (v_entry ->> 'db_card_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'mapping ids must be UUIDs'
        USING ERRCODE = '22023';
    END;

    IF v_item_id = ANY(v_seen_item_ids) THEN
      RAISE EXCEPTION 'duplicate item_id in mappings: %', v_item_id
        USING ERRCODE = '22023';
    END IF;
    v_seen_item_ids := array_append(v_seen_item_ids, v_item_id);
    v_results := v_results || jsonb_build_array(
      public.resolve_order_list_item_mapping(p_import_id, v_item_id, v_db_card_id)
    );
  END LOOP;

  SELECT
    count(*) FILTER (WHERE match_status IN ('ambiguous', 'unmatched'))::INT,
    count(*) FILTER (WHERE match_status = 'invalid')::INT
  INTO v_unselected_count, v_invalid_count
  FROM public.order_list_item
  WHERE import_id = p_import_id;

  IF v_unselected_count > 0 AND NOT coalesce(p_allow_unresolved, FALSE) THEN
    RAISE EXCEPTION 'unselected order_list_items remain: %', v_unselected_count
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'resolved_count', jsonb_array_length(v_results),
    'unselected_count', v_unselected_count,
    'invalid_count', v_invalid_count,
    'results', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_order_list_item_mappings(UUID, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_list_item_mappings(UUID, JSONB, BOOLEAN)
  TO service_role;

-- Recover a launch that never reached the worker, or a worker whose periodic
-- database heartbeat stopped. A live long-running worker keeps its lease fresh.
CREATE OR REPLACE FUNCTION public.recover_stale_order_list_imports(
  p_stale_before TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_import_ids UUID[];
  v_count INT := 0;
BEGIN
  SELECT ARRAY(
    SELECT id
    FROM public.order_list_import
    WHERE (
      status = 'confirmed'
      AND coalesce(confirmed_at, updated_at, created_at) < p_stale_before
    ) OR (
      status = 'processing'
      AND coalesce(heartbeat_at, processing_started_at, updated_at, created_at) < p_stale_before
    )
    FOR UPDATE
  )
  INTO v_import_ids;

  IF cardinality(v_import_ids) = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.run
  SET status = 'failed',
      error_message = '同期処理のリース期限切れ',
      completed_at = now()
  WHERE order_list_import_id = ANY(v_import_ids)
    AND status = 'running';

  UPDATE public.order_list_import
  SET status = 'failed',
      failed_at = now(),
      failure_message = '同期起動または処理のハートビートが2時間途絶えたため再実行待ちに戻しました',
      heartbeat_at = NULL,
      updated_at = now()
  WHERE id = ANY(v_import_ids)
    AND status IN ('confirmed', 'processing');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_order_list_imports(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_order_list_imports(TIMESTAMPTZ)
  TO service_role;
