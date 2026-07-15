-- Scope Excel order-list imports and running jobs by store.
--
-- harakawebapp and HarakaforMANMAN share the same Supabase project. Existing
-- rows were created by the Oripark deployment, so the backfill/default is
-- intentionally `oripark`; the MANMAN services always write STORE_NAME.

ALTER TABLE public.order_list_import
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

-- Product identities are store-owned as well. The two deployments share the
-- physical database, but rows in one storefront must never leak to the other.
ALTER TABLE public.db_card
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

ALTER TABLE public.excel_product_mapping
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

-- X posting configuration and plans are store-owned. During the expand phase
-- the default stays `oripark` so the currently deployed Oripark application
-- can continue omitting the column. A compatibility trigger below derives a
-- MANMAN plan's store from its Run until both applications write it explicitly.
ALTER TABLE public.x_credential
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

ALTER TABLE public.variable_registry
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

ALTER TABLE public.post_template
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

ALTER TABLE public.post_banner
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

ALTER TABLE public.post_plan
  ADD COLUMN IF NOT EXISTS store TEXT NOT NULL DEFAULT 'oripark';

UPDATE public.post_plan AS plan
SET store = run.store
FROM public.run AS run
WHERE run.id = plan.run_id
  AND plan.store IS DISTINCT FROM run.store;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_order_list_import_store'
      AND conrelid = 'public.order_list_import'::regclass
  ) THEN
    ALTER TABLE public.order_list_import
      ADD CONSTRAINT chk_order_list_import_store CHECK (btrim(store) <> '');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_db_card_store'
      AND conrelid = 'public.db_card'::regclass
  ) THEN
    ALTER TABLE public.db_card
      ADD CONSTRAINT chk_db_card_store CHECK (btrim(store) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_excel_product_mapping_store'
      AND conrelid = 'public.excel_product_mapping'::regclass
  ) THEN
    ALTER TABLE public.excel_product_mapping
      ADD CONSTRAINT chk_excel_product_mapping_store CHECK (btrim(store) <> '');
  END IF;
END
$$;

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT *
    FROM (VALUES
      ('public.x_credential'::REGCLASS, 'chk_x_credential_store'),
      ('public.variable_registry'::REGCLASS, 'chk_variable_registry_store'),
      ('public.post_template'::REGCLASS, 'chk_post_template_store'),
      ('public.post_banner'::REGCLASS, 'chk_post_banner_store'),
      ('public.post_plan'::REGCLASS, 'chk_post_plan_store')
    ) AS checks(table_oid, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = v_constraint.constraint_name
        AND conrelid = v_constraint.table_oid
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I CHECK (length(btrim(store)) > 0)',
        v_constraint.table_oid,
        v_constraint.constraint_name
      );
    END IF;
  END LOOP;
END
$$;

-- Expand phase: keep every legacy global constraint/index until both
-- deployments are store-aware. A later cleanup migration removes only those
-- legacy guards before the first MANMAN import is accepted.

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_file_per_store;

ALTER TABLE public.order_list_import
  ADD CONSTRAINT uix_order_list_import_file_per_store
  UNIQUE (store, business_date, sha256);

CREATE UNIQUE INDEX IF NOT EXISTS uix_db_card_identity_per_store
  ON public.db_card (store, franchise, card_name, grade, list_no);


ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS uix_excel_product_mapping_identity_per_store;

ALTER TABLE public.excel_product_mapping
  ADD CONSTRAINT uix_excel_product_mapping_identity_per_store
  UNIQUE (store, franchise, excel_product_key);

CREATE INDEX IF NOT EXISTS idx_db_card_store_franchise
  ON public.db_card (store, franchise, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_excel_product_mapping_store_status
  ON public.excel_product_mapping (store, status, franchise);

-- Fail with an actionable preflight message instead of a raw CREATE INDEX
-- error if legacy posting data is already ambiguous inside a store.
DO $$
DECLARE
  v_duplicate_x_users INT;
  v_duplicate_credential_defaults INT;
  v_duplicate_template_defaults INT;
  v_duplicate_banner_defaults INT;
BEGIN
  SELECT count(*)::INT
  INTO v_duplicate_x_users
  FROM (
    SELECT store, x_user_id
    FROM public.x_credential
    WHERE x_user_id IS NOT NULL
    GROUP BY store, x_user_id
    HAVING count(*) > 1
  ) AS duplicates;

  SELECT count(*)::INT
  INTO v_duplicate_credential_defaults
  FROM (
    SELECT store
    FROM public.x_credential
    WHERE is_default IS TRUE
    GROUP BY store
    HAVING count(*) > 1
  ) AS duplicates;

  SELECT count(*)::INT
  INTO v_duplicate_template_defaults
  FROM (
    SELECT store, coalesce(franchise, '') AS franchise_key
    FROM public.post_template
    WHERE is_default IS TRUE
    GROUP BY store, coalesce(franchise, '')
    HAVING count(*) > 1
  ) AS duplicates;

  SELECT count(*)::INT
  INTO v_duplicate_banner_defaults
  FROM (
    SELECT store, coalesce(franchise, '') AS franchise_key
    FROM public.post_banner
    WHERE is_default IS TRUE
    GROUP BY store, coalesce(franchise, '')
    HAVING count(*) > 1
  ) AS duplicates;

  IF v_duplicate_x_users > 0
    OR v_duplicate_credential_defaults > 0
    OR v_duplicate_template_defaults > 0
    OR v_duplicate_banner_defaults > 0 THEN
    RAISE EXCEPTION 'cannot expand posting store isolation: duplicate X users %, credential defaults %, template defaults %, banner defaults %',
      v_duplicate_x_users,
      v_duplicate_credential_defaults,
      v_duplicate_template_defaults,
      v_duplicate_banner_defaults
      USING ERRCODE = '55000',
            HINT = 'Resolve duplicate posting identities/defaults within each store before applying 00004';
  END IF;
END
$$;

-- Per-store posting identities are prepared in the expand phase while the
-- legacy global variable key remains in place. The contract migration drops
-- only that global key before creating MANMAN's system-variable snapshot.
ALTER TABLE public.variable_registry
  DROP CONSTRAINT IF EXISTS uix_variable_registry_key_per_store;
ALTER TABLE public.variable_registry
  ADD CONSTRAINT uix_variable_registry_key_per_store UNIQUE (store, key);

CREATE UNIQUE INDEX IF NOT EXISTS uix_x_credential_user_per_store
  ON public.x_credential (store, x_user_id)
  WHERE x_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uix_x_credential_default_per_store
  ON public.x_credential (store)
  WHERE is_default IS TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uix_post_template_default_per_store_franchise
  ON public.post_template (store, coalesce(franchise, ''))
  WHERE is_default IS TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uix_post_banner_default_per_store_franchise
  ON public.post_banner (store, coalesce(franchise, ''))
  WHERE is_default IS TRUE;

CREATE INDEX IF NOT EXISTS idx_x_credential_store_created_at
  ON public.x_credential (store, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_variable_registry_store_source
  ON public.variable_registry (store, source, created_at);

CREATE INDEX IF NOT EXISTS idx_post_template_store_created_at
  ON public.post_template (store, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_banner_store_created_at
  ON public.post_banner (store, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_plan_store_run
  ON public.post_plan (store, run_id);

-- Composite keys let the database reject cross-store mapping/run references,
-- even if a future caller bypasses the service RPCs.
ALTER TABLE public.db_card
  DROP CONSTRAINT IF EXISTS uix_db_card_store_id;
ALTER TABLE public.db_card
  ADD CONSTRAINT uix_db_card_store_id UNIQUE (store, id);

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_store_id;
ALTER TABLE public.order_list_import
  ADD CONSTRAINT uix_order_list_import_store_id UNIQUE (store, id);

ALTER TABLE public.run
  DROP CONSTRAINT IF EXISTS uix_run_store_id;
ALTER TABLE public.run
  ADD CONSTRAINT uix_run_store_id UNIQUE (store, id);

ALTER TABLE public.x_credential
  DROP CONSTRAINT IF EXISTS uix_x_credential_store_id;
ALTER TABLE public.x_credential
  ADD CONSTRAINT uix_x_credential_store_id UNIQUE (store, id);

ALTER TABLE public.variable_registry
  DROP CONSTRAINT IF EXISTS uix_variable_registry_store_id;
ALTER TABLE public.variable_registry
  ADD CONSTRAINT uix_variable_registry_store_id UNIQUE (store, id);

ALTER TABLE public.post_template
  DROP CONSTRAINT IF EXISTS uix_post_template_store_id;
ALTER TABLE public.post_template
  ADD CONSTRAINT uix_post_template_store_id UNIQUE (store, id);

ALTER TABLE public.post_banner
  DROP CONSTRAINT IF EXISTS uix_post_banner_store_id;
ALTER TABLE public.post_banner
  ADD CONSTRAINT uix_post_banner_store_id UNIQUE (store, id);

ALTER TABLE public.post_plan
  DROP CONSTRAINT IF EXISTS uix_post_plan_store_id;
ALTER TABLE public.post_plan
  ADD CONSTRAINT uix_post_plan_store_id UNIQUE (store, id);

-- Compatibility for the short expand/deploy window: legacy MANMAN code does
-- not yet send post_plan.store, so derive it from the selected Run. The
-- contract migration removes this trigger and replaces it with strict
-- composite foreign keys after both applications are store-aware.
CREATE OR REPLACE FUNCTION public.assign_post_plan_store_from_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_store TEXT;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT store
    INTO v_store
    FROM public.run
    WHERE id = NEW.run_id;

    IF FOUND THEN
      NEW.store := v_store;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_post_plan_store_from_run()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_assign_post_plan_store_from_run
  ON public.post_plan;
CREATE TRIGGER trg_assign_post_plan_store_from_run
  BEFORE INSERT OR UPDATE OF run_id ON public.post_plan
  FOR EACH ROW EXECUTE FUNCTION public.assign_post_plan_store_from_run();

ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS fk_excel_product_mapping_store_db_card;
ALTER TABLE public.excel_product_mapping
  ADD CONSTRAINT fk_excel_product_mapping_store_db_card
  FOREIGN KEY (store, db_card_id)
  REFERENCES public.db_card (store, id);

ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS fk_excel_product_mapping_store_first_import;
ALTER TABLE public.excel_product_mapping
  ADD CONSTRAINT fk_excel_product_mapping_store_first_import
  FOREIGN KEY (store, first_seen_import_id)
  REFERENCES public.order_list_import (store, id);

ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS fk_excel_product_mapping_store_last_import;
ALTER TABLE public.excel_product_mapping
  ADD CONSTRAINT fk_excel_product_mapping_store_last_import
  FOREIGN KEY (store, last_seen_import_id)
  REFERENCES public.order_list_import (store, id);

ALTER TABLE public.run
  DROP CONSTRAINT IF EXISTS fk_run_store_order_list_import;
ALTER TABLE public.run
  ADD CONSTRAINT fk_run_store_order_list_import
  FOREIGN KEY (store, order_list_import_id)
  REFERENCES public.order_list_import (store, id);
-- order_list_item derives its owner from import_id. Guard its optional mapping
-- and card references because the legacy table has no duplicated store column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_list_item AS item
    JOIN public.order_list_import AS imported ON imported.id = item.import_id
    JOIN public.excel_product_mapping AS mapping ON mapping.id = item.mapping_id
    WHERE mapping.store <> imported.store
  ) OR EXISTS (
    SELECT 1
    FROM public.order_list_item AS item
    JOIN public.order_list_import AS imported ON imported.id = item.import_id
    JOIN public.db_card AS card ON card.id = item.db_card_id
    WHERE card.store <> imported.store
  ) THEN
    RAISE EXCEPTION 'existing order_list_item contains a cross-store reference'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_order_list_item_store()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_store TEXT;
BEGIN
  SELECT store INTO v_store
  FROM public.order_list_import
  WHERE id = NEW.import_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.mapping_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.excel_product_mapping
    WHERE id = NEW.mapping_id AND store = v_store
  ) THEN
    RAISE EXCEPTION 'order_list_item mapping belongs to another store: %', NEW.mapping_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.db_card_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.db_card
    WHERE id = NEW.db_card_id AND store = v_store
  ) THEN
    RAISE EXCEPTION 'order_list_item db_card belongs to another store: %', NEW.db_card_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_order_list_item_store()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_order_list_item_store_guard
  ON public.order_list_item;
CREATE TRIGGER trg_order_list_item_store_guard
  BEFORE INSERT OR UPDATE ON public.order_list_item
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_list_item_store();

CREATE UNIQUE INDEX IF NOT EXISTS uix_order_list_import_single_active_per_store
  ON public.order_list_import (store)
  WHERE status IN ('confirmed', 'processing');

CREATE INDEX IF NOT EXISTS idx_order_list_import_store_business_date
  ON public.order_list_import (store, business_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_list_import_store_status
  ON public.order_list_import (store, status, created_at DESC);

-- The original migration allowed only one running job across the shared
-- project. Runs already carry `store`, so isolate the guard per deployment.
CREATE UNIQUE INDEX IF NOT EXISTS uix_run_single_running_per_store
  ON public.run (store)
  WHERE status = 'running';

-- Store-scoped stale recovery for the MANMAN watchdog.
CREATE OR REPLACE FUNCTION public.recover_stale_order_list_imports_for_store(
  p_store TEXT,
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
  IF nullif(btrim(p_store), '') IS NULL THEN
    RAISE EXCEPTION 'store is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(
    SELECT id
    FROM public.order_list_import
    WHERE store = p_store
      AND (
        (
          status = 'confirmed'
          AND coalesce(confirmed_at, updated_at, created_at) < p_stale_before
        ) OR (
          status = 'processing'
          AND coalesce(heartbeat_at, processing_started_at, updated_at, created_at) < p_stale_before
        )
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
  WHERE store = p_store
    AND order_list_import_id = ANY(v_import_ids)
    AND status = 'running';

  UPDATE public.order_list_import
  SET status = 'failed',
      failed_at = now(),
      failure_message = '同期起動または処理のハートビートが2時間途絶えたため再実行待ちに戻しました',
      heartbeat_at = NULL,
      updated_at = now()
  WHERE store = p_store
    AND id = ANY(v_import_ids)
    AND status IN ('confirmed', 'processing');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_order_list_imports_for_store(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_order_list_imports_for_store(TEXT, TIMESTAMPTZ)
  TO service_role;

-- The existing Oripark deployment still calls the original one-argument RPC.
-- Preserve that signature while preventing it from recovering MANMAN imports.
CREATE OR REPLACE FUNCTION public.recover_stale_order_list_imports(
  p_stale_before TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN public.recover_stale_order_list_imports_for_store(
    'oripark',
    p_stale_before
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_order_list_imports(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_order_list_imports(TIMESTAMPTZ)
  TO service_role;
