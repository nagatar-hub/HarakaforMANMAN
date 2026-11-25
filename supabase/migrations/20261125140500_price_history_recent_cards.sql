SET LOCAL lock_timeout = '2s';

-- Frequent card names can satisfy the history limit by scanning the newest rows first.
CREATE INDEX IF NOT EXISTS idx_prepared_card_created_at
  ON public.prepared_card (created_at DESC);
