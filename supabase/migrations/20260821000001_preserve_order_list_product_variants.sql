-- Expand phase: make the six-column conflict target available to both the
-- current and compatible application revisions. Keep the legacy five-column
-- unique index until the compatible revision is deployed everywhere.
BEGIN;

ALTER TABLE public.db_card
  ADD COLUMN IF NOT EXISTS source_product_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uix_db_card_identity_source_per_store
  ON public.db_card (
    store, franchise, card_name, grade, list_no, source_product_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS uix_db_card_source_product_per_store
  ON public.db_card (store, franchise, source_product_id)
  WHERE source_product_id <> '';

COMMIT;
