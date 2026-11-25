-- Support the two substring predicates used by the published price history search.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_prepared_card_name_trgm
  ON public.prepared_card USING gin (card_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prepared_card_list_no_trgm
  ON public.prepared_card USING gin (list_no extensions.gin_trgm_ops);
