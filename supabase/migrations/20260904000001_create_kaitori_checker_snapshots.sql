BEGIN;

CREATE TABLE public.kaitori_checker_sync_run (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store              TEXT NOT NULL CHECK (btrim(store) <> ''),
  request_key        TEXT NOT NULL CHECK (btrim(request_key) <> ''),
  trigger            TEXT NOT NULL CHECK (trigger IN ('scheduler', 'manual')),
  claim_token        TEXT NOT NULL CHECK (btrim(claim_token) <> ''),
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'applied', 'failed')),
  progress_page      INT NOT NULL DEFAULT 0 CHECK (progress_page >= 0),
  product_count      INT NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  offer_count        INT NOT NULL DEFAULT 0 CHECK (offer_count >= 0),
  ranking_count      INT NOT NULL DEFAULT 0 CHECK (ranking_count >= 0),
  content_hash       TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  error              TEXT,
  sheet_published_at TIMESTAMPTZ,
  sheet_error        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uix_kaitori_checker_sync_run_request UNIQUE (store, request_key),
  CONSTRAINT uix_kaitori_checker_sync_run_store_id UNIQUE (store, id),
  CONSTRAINT chk_kaitori_checker_sync_run_terminal CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR (status IN ('applied', 'failed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT chk_kaitori_checker_sync_run_applied CHECK (
    status <> 'applied'
    OR (content_hash IS NOT NULL AND product_count > 0 AND offer_count > 0 AND ranking_count > 0)
  )
);

CREATE UNIQUE INDEX uix_kaitori_checker_sync_run_single_running_per_store
  ON public.kaitori_checker_sync_run (store)
  WHERE status = 'running';

CREATE INDEX idx_kaitori_checker_sync_run_latest
  ON public.kaitori_checker_sync_run (store, completed_at DESC, created_at DESC)
  WHERE status = 'applied';

CREATE TABLE public.kaitori_checker_product_snapshot (
  run_id                UUID NOT NULL,
  store                 TEXT NOT NULL,
  source_product_id     BIGINT NOT NULL CHECK (source_product_id > 0),
  category_id           BIGINT CHECK (category_id IS NULL OR category_id >= 0),
  category              TEXT NOT NULL CHECK (btrim(category) <> ''),
  product_type_id       BIGINT CHECK (product_type_id IS NULL OR product_type_id >= 0),
  name                  TEXT NOT NULL CHECK (btrim(name) <> ''),
  full_name             TEXT,
  model_number          TEXT,
  rarity                TEXT,
  holo_type             TEXT,
  aspect                TEXT,
  priority_condition_id BIGINT CHECK (
                          priority_condition_id IS NULL OR priority_condition_id >= 0),
  pack_name             TEXT,
  image_url             TEXT,
  tag_names             TEXT[] NOT NULL DEFAULT '{}',
  tag_ids               BIGINT[] NOT NULL DEFAULT '{}',
  price_7d_min          NUMERIC CHECK (price_7d_min IS NULL OR price_7d_min >= 0),
  price_7d_max          NUMERIC CHECK (price_7d_max IS NULL OR price_7d_max >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, source_product_id),
  FOREIGN KEY (store, run_id)
    REFERENCES public.kaitori_checker_sync_run (store, id) ON DELETE CASCADE,
  CHECK (price_7d_min IS NULL OR price_7d_max IS NULL OR price_7d_min <= price_7d_max)
);

CREATE INDEX idx_kaitori_checker_product_snapshot_store_category
  ON public.kaitori_checker_product_snapshot (store, category, source_product_id);

CREATE TABLE public.kaitori_checker_offer_snapshot (
  run_id             UUID NOT NULL,
  store              TEXT NOT NULL,
  source_product_id  BIGINT NOT NULL CHECK (source_product_id > 0),
  shop_id            BIGINT NOT NULL DEFAULT 0 CHECK (shop_id >= 0),
  condition_id       BIGINT NOT NULL DEFAULT 0 CHECK (condition_id >= 0),
  edition_id         BIGINT NOT NULL DEFAULT 0 CHECK (edition_id >= 0),
  buy_price          NUMERIC NOT NULL CHECK (buy_price >= 0),
  ask_flag           BOOLEAN NOT NULL DEFAULT FALSE,
  shop_name          TEXT NOT NULL CHECK (btrim(shop_name) <> ''),
  shop_name_en       TEXT,
  condition_name     TEXT,
  edition_name       TEXT,
  icon_url           TEXT,
  buy_apply_url      TEXT,
  buy_line_url       TEXT,
  mail_buy           BOOLEAN NOT NULL DEFAULT FALSE,
  store_buy          BOOLEAN NOT NULL DEFAULT FALSE,
  verified_badge     BOOLEAN NOT NULL DEFAULT FALSE,
  is_ad_sponsor      BOOLEAN NOT NULL DEFAULT FALSE,
  is_buy_pr          BOOLEAN NOT NULL DEFAULT FALSE,
  has_buy_flow       BOOLEAN NOT NULL DEFAULT FALSE,
  source_updated_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, source_product_id, shop_id, condition_id, edition_id),
  FOREIGN KEY (store, run_id)
    REFERENCES public.kaitori_checker_sync_run (store, id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, source_product_id)
    REFERENCES public.kaitori_checker_product_snapshot (run_id, source_product_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_kaitori_checker_offer_snapshot_product_price
  ON public.kaitori_checker_offer_snapshot
    (store, source_product_id, condition_id, buy_price DESC);

CREATE TABLE public.kaitori_checker_ranking_snapshot (
  run_id            UUID NOT NULL,
  store             TEXT NOT NULL,
  ranking_type      TEXT NOT NULL CHECK (btrim(ranking_type) <> ''),
  category          TEXT NOT NULL CHECK (btrim(category) <> ''),
  rank              INT NOT NULL CHECK (rank > 0),
  source_product_id BIGINT CHECK (source_product_id IS NULL OR source_product_id > 0),
  product_name      TEXT NOT NULL CHECK (btrim(product_name) <> ''),
  model_number      TEXT,
  image_url         TEXT,
  buy_price         NUMERIC CHECK (buy_price IS NULL OR buy_price >= 0),
  price_change      NUMERIC,
  shop_change_count INT CHECK (shop_change_count IS NULL OR shop_change_count >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, ranking_type, category, rank),
  FOREIGN KEY (store, run_id)
    REFERENCES public.kaitori_checker_sync_run (store, id) ON DELETE CASCADE
);

CREATE INDEX idx_kaitori_checker_ranking_snapshot_store
  ON public.kaitori_checker_ranking_snapshot (store, ranking_type, category, rank);

CREATE OR REPLACE FUNCTION public.claim_kaitori_checker_sync(
  p_store TEXT,
  p_request_key TEXT,
  p_trigger TEXT,
  p_claim_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.kaitori_checker_sync_run%ROWTYPE;
BEGIN
  IF btrim(COALESCE(p_store, '')) = ''
    OR btrim(COALESCE(p_request_key, '')) = ''
    OR btrim(COALESCE(p_claim_token, '')) = ''
    OR p_trigger NOT IN ('scheduler', 'manual') THEN
    RAISE EXCEPTION 'invalid kaitori checker sync claim'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('kaitori-checker:' || p_store, 0));

  -- Cloud Run times out after 3 hours. Recover only runs with no progress for 4 hours.
  UPDATE public.kaitori_checker_sync_run
  SET status = 'failed',
      completed_at = clock_timestamp(),
      error = 'stale running sync recovered after 4 hours',
      updated_at = clock_timestamp()
  WHERE store = p_store
    AND status = 'running'
    AND updated_at < clock_timestamp() - INTERVAL '4 hours';

  SELECT * INTO v_run
  FROM public.kaitori_checker_sync_run
  WHERE store = p_store AND request_key = p_request_key;

  IF FOUND THEN
    IF v_run.status = 'running' THEN
      RETURN jsonb_build_object(
        'action', CASE
          WHEN v_run.claim_token = p_claim_token THEN 'resume_job'
          ELSE 'already_running'
        END,
        'run_id', v_run.id,
        'status', v_run.status
      );
    END IF;
    RETURN jsonb_build_object(
      'action', 'noop', 'run_id', v_run.id, 'status', v_run.status
    );
  END IF;

  SELECT * INTO v_run
  FROM public.kaitori_checker_sync_run
  WHERE store = p_store AND status = 'running'
  ORDER BY started_at, created_at
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'action', 'already_running', 'run_id', v_run.id, 'status', v_run.status
    );
  END IF;

  INSERT INTO public.kaitori_checker_sync_run (
    store, request_key, trigger, claim_token, status, started_at
  ) VALUES (
    p_store, p_request_key, p_trigger, p_claim_token, 'running', clock_timestamp()
  )
  RETURNING * INTO v_run;

  RETURN jsonb_build_object(
    'action', 'start_job', 'run_id', v_run.id, 'status', v_run.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_kaitori_checker_progress(
  p_run_id UUID,
  p_store TEXT,
  p_claim_token TEXT,
  p_page INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_page INT;
BEGIN
  IF btrim(COALESCE(p_claim_token, '')) = '' OR p_page IS NULL OR p_page < 0 THEN
    RAISE EXCEPTION 'invalid kaitori checker progress metadata'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.kaitori_checker_sync_run
  SET progress_page = GREATEST(progress_page, p_page),
      updated_at = clock_timestamp()
  WHERE id = p_run_id
    AND store = p_store
    AND claim_token = p_claim_token
    AND status = 'running'
  RETURNING progress_page INTO v_page;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'running kaitori checker run claim not found for store'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'run_id', p_run_id, 'status', 'running', 'progress_page', v_page
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_kaitori_checker_sync(
  p_run_id UUID,
  p_store TEXT,
  p_claim_token TEXT,
  p_product_count INT,
  p_offer_count INT,
  p_ranking_count INT,
  p_content_hash TEXT,
  p_completed_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.kaitori_checker_sync_run%ROWTYPE;
  v_product_count INT;
  v_offer_count INT;
  v_ranking_count INT;
BEGIN
  IF p_product_count <= 0 OR p_offer_count <= 0 OR p_ranking_count <= 0
    OR btrim(COALESCE(p_claim_token, '')) = ''
    OR p_content_hash !~ '^[0-9a-f]{64}$' OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid kaitori checker finalize metadata'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run
  FROM public.kaitori_checker_sync_run
  WHERE id = p_run_id AND store = p_store AND claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'kaitori checker run not found for store'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'kaitori checker run is %, expected running', v_run.status
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::INT INTO v_product_count
  FROM public.kaitori_checker_product_snapshot
  WHERE run_id = p_run_id AND store = p_store;
  SELECT count(*)::INT INTO v_offer_count
  FROM public.kaitori_checker_offer_snapshot
  WHERE run_id = p_run_id AND store = p_store;
  SELECT count(*)::INT INTO v_ranking_count
  FROM public.kaitori_checker_ranking_snapshot
  WHERE run_id = p_run_id AND store = p_store;

  IF ROW(v_product_count, v_offer_count, v_ranking_count)
    IS DISTINCT FROM ROW(p_product_count, p_offer_count, p_ranking_count) THEN
    RAISE EXCEPTION 'kaitori checker snapshot counts mismatch: stored=(%,%,%), supplied=(%,%,%)',
      v_product_count, v_offer_count, v_ranking_count,
      p_product_count, p_offer_count, p_ranking_count
      USING ERRCODE = '22000';
  END IF;

  UPDATE public.kaitori_checker_sync_run
  SET status = 'applied',
      product_count = v_product_count,
      offer_count = v_offer_count,
      ranking_count = v_ranking_count,
      content_hash = p_content_hash,
      completed_at = p_completed_at,
      error = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_run_id AND store = p_store;

  -- Product and offer data retain only the latest two applied generations.
  DELETE FROM public.kaitori_checker_product_snapshot AS product
  USING public.kaitori_checker_sync_run AS run
  WHERE product.run_id = run.id
    AND run.store = p_store
    AND run.status = 'applied'
    AND run.id NOT IN (
      SELECT id
      FROM public.kaitori_checker_sync_run
      WHERE store = p_store AND status = 'applied'
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 2
    );

  -- Run metadata and ranking history are useful for operations, but only for 90 days.
  DELETE FROM public.kaitori_checker_sync_run
  WHERE store = p_store
    AND id <> p_run_id
    AND status IN ('applied', 'failed')
    AND completed_at < clock_timestamp() - INTERVAL '90 days';

  RETURN jsonb_build_object(
    'run_id', p_run_id,
    'status', 'applied',
    'product_count', v_product_count,
    'offer_count', v_offer_count,
    'ranking_count', v_ranking_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_kaitori_checker_sync(
  p_run_id UUID,
  p_store TEXT,
  p_claim_token TEXT,
  p_error TEXT,
  p_completed_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF btrim(COALESCE(p_claim_token, '')) = ''
    OR btrim(COALESCE(p_error, '')) = '' OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid kaitori checker failure metadata'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.kaitori_checker_sync_run
  SET status = 'failed',
      error = p_error,
      completed_at = p_completed_at,
      updated_at = clock_timestamp()
  WHERE id = p_run_id AND store = p_store
    AND claim_token = p_claim_token AND status = 'running'
  RETURNING status INTO v_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'running kaitori checker run not found for store'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('run_id', p_run_id, 'status', v_status);
END;
$$;

CREATE VIEW public.kaitori_checker_latest_product
WITH (security_invoker = TRUE)
AS
SELECT product.*
FROM public.kaitori_checker_product_snapshot AS product
JOIN LATERAL (
  SELECT id
  FROM public.kaitori_checker_sync_run
  WHERE store = product.store AND status = 'applied'
  ORDER BY completed_at DESC, created_at DESC
  LIMIT 1
) AS latest ON latest.id = product.run_id;

CREATE VIEW public.kaitori_checker_latest_offer
WITH (security_invoker = TRUE)
AS
SELECT offer.*
FROM public.kaitori_checker_offer_snapshot AS offer
JOIN LATERAL (
  SELECT id
  FROM public.kaitori_checker_sync_run
  WHERE store = offer.store AND status = 'applied'
  ORDER BY completed_at DESC, created_at DESC
  LIMIT 1
) AS latest ON latest.id = offer.run_id;

CREATE VIEW public.kaitori_checker_latest_ranking
WITH (security_invoker = TRUE)
AS
SELECT ranking.*
FROM public.kaitori_checker_ranking_snapshot AS ranking
JOIN LATERAL (
  SELECT id
  FROM public.kaitori_checker_sync_run
  WHERE store = ranking.store AND status = 'applied'
  ORDER BY completed_at DESC, created_at DESC
  LIMIT 1
) AS latest ON latest.id = ranking.run_id;

ALTER TABLE public.kaitori_checker_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kaitori_checker_product_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kaitori_checker_offer_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kaitori_checker_ranking_snapshot ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.kaitori_checker_sync_run,
  public.kaitori_checker_product_snapshot,
  public.kaitori_checker_offer_snapshot,
  public.kaitori_checker_ranking_snapshot
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.kaitori_checker_sync_run,
  public.kaitori_checker_product_snapshot,
  public.kaitori_checker_offer_snapshot,
  public.kaitori_checker_ranking_snapshot
TO service_role;

REVOKE ALL ON TABLE
  public.kaitori_checker_latest_product,
  public.kaitori_checker_latest_offer,
  public.kaitori_checker_latest_ranking
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.kaitori_checker_latest_product,
  public.kaitori_checker_latest_offer,
  public.kaitori_checker_latest_ranking
TO service_role;

REVOKE ALL ON FUNCTION public.claim_kaitori_checker_sync(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_kaitori_checker_sync(TEXT, TEXT, TEXT, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.update_kaitori_checker_progress(UUID, TEXT, TEXT, INT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_kaitori_checker_progress(UUID, TEXT, TEXT, INT)
  TO service_role;
REVOKE ALL ON FUNCTION public.finalize_kaitori_checker_sync(
  UUID, TEXT, TEXT, INT, INT, INT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_kaitori_checker_sync(
  UUID, TEXT, TEXT, INT, INT, INT, TEXT, TIMESTAMPTZ
) TO service_role;
REVOKE ALL ON FUNCTION public.fail_kaitori_checker_sync(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_kaitori_checker_sync(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
