-- Contract phase. Apply only after both Oripark and MANMAN services are
-- deployed with store-aware db_card, import, mapping, and run queries.
-- 00004-00006 deliberately keep these global guards for a zero-downtime
-- expand/deploy/contract rollout.
BEGIN;

-- Close the preflight/write race while upgrading MANMAN to the same generation
-- fencing invariants already enforced for Oripark.
LOCK TABLE public.run IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.x_credential IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.variable_registry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.post_template IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.post_banner IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.post_plan IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_generated_running INT;
  v_unfenced_planned_running INT;
  v_cross_store_plans INT;
  v_system_variable_conflicts INT;
BEGIN
  SELECT count(*)::INT INTO v_generated_running
  FROM public.run
  WHERE status = 'running' AND generate_done_at IS NOT NULL;
  IF v_generated_running > 0 THEN
    RAISE EXCEPTION 'cannot finalize store isolation: % generated Runs are still running',
      v_generated_running
      USING ERRCODE = '55000',
            HINT = 'Recover or fail these Runs with the deployed fenced watchdog before applying 00007';
  END IF;

  SELECT count(*)::INT INTO v_unfenced_planned_running
  FROM public.run
  WHERE status = 'running'
    AND plan_done_at IS NOT NULL
    AND (generate_claimed_at IS NULL OR generate_claim_token IS NULL);
  IF v_unfenced_planned_running > 0 THEN
    RAISE EXCEPTION 'cannot finalize store isolation: % planned Runs lack generation fencing',
      v_unfenced_planned_running
      USING ERRCODE = '55000',
            HINT = 'Deploy generation claim-token support and recover these Runs before applying 00007';
  END IF;
  SELECT count(*)::INT
  INTO v_cross_store_plans
  FROM public.post_plan AS plan
  LEFT JOIN public.run AS run
    ON run.id = plan.run_id
  LEFT JOIN public.post_template AS template
    ON template.id = plan.template_id
  LEFT JOIN public.post_banner AS banner
    ON banner.id = plan.banner_id
  LEFT JOIN public.x_credential AS credential
    ON credential.id = plan.x_credential_id
  WHERE (
      plan.run_id IS NOT NULL
      AND (run.id IS NULL OR run.store IS DISTINCT FROM plan.store)
    ) OR (
      plan.template_id IS NOT NULL
      AND (template.id IS NULL OR template.store IS DISTINCT FROM plan.store)
    ) OR (
      plan.banner_id IS NOT NULL
      AND (banner.id IS NULL OR banner.store IS DISTINCT FROM plan.store)
    ) OR (
      plan.x_credential_id IS NOT NULL
      AND (credential.id IS NULL OR credential.store IS DISTINCT FROM plan.store)
    );
  IF v_cross_store_plans > 0 THEN
    RAISE EXCEPTION 'cannot finalize store isolation: % post_plan rows reference another store',
      v_cross_store_plans
      USING ERRCODE = '55000',
            HINT = 'Reconfigure each MANMAN plan with MANMAN-owned templates, banners, and credentials before retrying; credentials and branded assets are never cloned automatically';
  END IF;

  SELECT count(*)::INT
  INTO v_system_variable_conflicts
  FROM public.variable_registry AS oripark
  JOIN public.variable_registry AS manman
    ON manman.store = 'manman'
   AND manman.key = oripark.key
  WHERE oripark.store = 'oripark'
    AND (oripark.source = 'system' OR oripark.is_deletable IS FALSE)
    AND ROW(
      manman.label,
      manman.source,
      manman.resolve_type,
      manman.default_value,
      manman.description,
      manman.is_deletable
    ) IS DISTINCT FROM ROW(
      oripark.label,
      oripark.source,
      oripark.resolve_type,
      oripark.default_value,
      oripark.description,
      oripark.is_deletable
    );
  IF v_system_variable_conflicts > 0 THEN
    RAISE EXCEPTION 'cannot finalize store isolation: % MANMAN variables conflict with the Oripark system-variable snapshot',
      v_system_variable_conflicts
      USING ERRCODE = '55000',
            HINT = 'Rename or remove the conflicting MANMAN custom variables before retrying';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uix_order_list_import_file_per_store'
      AND conrelid = 'public.order_list_import'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uix_excel_product_mapping_identity_per_store'
      AND conrelid = 'public.excel_product_mapping'::regclass
  ) OR to_regclass('public.uix_db_card_identity_per_store') IS NULL
    OR to_regclass('public.uix_order_list_import_single_active_per_store') IS NULL
    OR to_regclass('public.uix_run_single_running_per_store') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_variable_registry_key_per_store'
        AND conrelid = 'public.variable_registry'::regclass
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_run_store_id'
        AND conrelid = 'public.run'::regclass
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_x_credential_store_id'
        AND conrelid = 'public.x_credential'::regclass
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_post_template_store_id'
        AND conrelid = 'public.post_template'::regclass
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_post_banner_store_id'
        AND conrelid = 'public.post_banner'::regclass
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uix_post_plan_store_id'
        AND conrelid = 'public.post_plan'::regclass
    )
    OR to_regclass('public.uix_x_credential_default_per_store') IS NULL
    OR to_regclass('public.uix_post_template_default_per_store_franchise') IS NULL
    OR to_regclass('public.uix_post_banner_default_per_store_franchise') IS NULL THEN
    RAISE EXCEPTION 'store isolation expand phase is incomplete'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE public.order_list_import
  DROP CONSTRAINT IF EXISTS uix_order_list_import_file;

ALTER TABLE public.excel_product_mapping
  DROP CONSTRAINT IF EXISTS uix_excel_product_mapping_identity;

DROP INDEX IF EXISTS public.uix_db_card_identity;
DROP INDEX IF EXISTS public.uix_order_list_import_single_active;
DROP INDEX IF EXISTS public.uix_run_single_running;

-- The original inline UNIQUE(key) blocks the same variable name in both
-- stores. Remove it only now, after both applications are store-aware and the
-- per-store replacement has been verified above.
ALTER TABLE public.variable_registry
  DROP CONSTRAINT IF EXISTS variable_registry_key_key;
DROP INDEX IF EXISTS public.variable_registry_key_key;

-- System variables are application vocabulary, not branded/operator data.
-- Snapshot only immutable/system definitions for MANMAN. X credentials,
-- templates, banners, and custom variables must be created explicitly in the
-- MANMAN settings UI so tokens and Oripark branding can never leak.
INSERT INTO public.variable_registry (
  id,
  store,
  key,
  label,
  source,
  resolve_type,
  default_value,
  description,
  is_deletable,
  created_at
)
SELECT
  gen_random_uuid(),
  'manman',
  oripark.key,
  oripark.label,
  oripark.source,
  oripark.resolve_type,
  oripark.default_value,
  oripark.description,
  oripark.is_deletable,
  oripark.created_at
FROM public.variable_registry AS oripark
WHERE oripark.store = 'oripark'
  AND (oripark.source = 'system' OR oripark.is_deletable IS FALSE)
ON CONFLICT (store, key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_assign_post_plan_store_from_run
  ON public.post_plan;
DROP FUNCTION IF EXISTS public.assign_post_plan_store_from_run();

ALTER TABLE public.post_plan
  DROP CONSTRAINT IF EXISTS fk_post_plan_store_run;
ALTER TABLE public.post_plan
  ADD CONSTRAINT fk_post_plan_store_run
  FOREIGN KEY (store, run_id)
  REFERENCES public.run (store, id);

ALTER TABLE public.post_plan
  DROP CONSTRAINT IF EXISTS fk_post_plan_store_template;
ALTER TABLE public.post_plan
  ADD CONSTRAINT fk_post_plan_store_template
  FOREIGN KEY (store, template_id)
  REFERENCES public.post_template (store, id);

ALTER TABLE public.post_plan
  DROP CONSTRAINT IF EXISTS fk_post_plan_store_banner;
ALTER TABLE public.post_plan
  ADD CONSTRAINT fk_post_plan_store_banner
  FOREIGN KEY (store, banner_id)
  REFERENCES public.post_banner (store, id);

ALTER TABLE public.post_plan
  DROP CONSTRAINT IF EXISTS fk_post_plan_store_x_credential;
ALTER TABLE public.post_plan
  ADD CONSTRAINT fk_post_plan_store_x_credential
  FOREIGN KEY (store, x_credential_id)
  REFERENCES public.x_credential (store, id);

ALTER TABLE public.run
  DROP CONSTRAINT IF EXISTS run_running_requires_generate_pending,
  DROP CONSTRAINT IF EXISTS run_planned_running_requires_generate_claim;

ALTER TABLE public.run
  ADD CONSTRAINT run_running_requires_generate_pending
    CHECK (status <> 'running' OR generate_done_at IS NULL),
  ADD CONSTRAINT run_planned_running_requires_generate_claim
    CHECK (
      status <> 'running'
      OR plan_done_at IS NULL
      OR (generate_claimed_at IS NOT NULL AND generate_claim_token IS NOT NULL)
    );

COMMENT ON CONSTRAINT run_running_requires_generate_pending ON public.run IS
  'Every store forbids a generated Run from returning to running.';
COMMENT ON CONSTRAINT run_planned_running_requires_generate_claim ON public.run IS
  'Every store requires a fenced claim before a planned Run can be running.';

NOTIFY pgrst, 'reload schema';
COMMIT;
