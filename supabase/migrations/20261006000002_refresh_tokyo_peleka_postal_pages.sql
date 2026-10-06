BEGIN;

CREATE TABLE public.tokyo_peleka_postal_refresh (
  run_id UUID PRIMARY KEY REFERENCES public.run(id),
  request_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  revision INTEGER,
  fingerprint TEXT,
  page_count INTEGER,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tokyo_peleka_postal_refresh ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_tokyo_peleka_postal_refresh(
  p_run_id UUID, p_request_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM public.run
  WHERE id = p_run_id AND store = 'manman-akihabara' AND status = 'completed'
    AND generate_done_at IS NOT NULL AND tokyo_snapshot_id IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Completed Tokyo run not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.generated_page WHERE run_id = p_run_id AND kind = 'store')
    OR EXISTS (SELECT 1 FROM public.generated_page
      WHERE run_id = p_run_id AND kind = 'store' AND status <> 'generated') THEN
    RAISE EXCEPTION 'Store pages are incomplete';
  END IF;

  INSERT INTO public.tokyo_peleka_postal_refresh (
    run_id, request_id, status, revision, fingerprint, page_count,
    error_message, started_at, completed_at, updated_at
  ) VALUES (p_run_id, p_request_id, 'running', NULL, NULL, NULL, NULL, now(), NULL, now())
  ON CONFLICT (run_id) DO UPDATE SET
    request_id = EXCLUDED.request_id, status = 'running', revision = NULL, fingerprint = NULL,
    page_count = NULL, error_message = NULL, started_at = now(), completed_at = NULL, updated_at = now()
  WHERE public.tokyo_peleka_postal_refresh.status <> 'running'
    OR public.tokyo_peleka_postal_refresh.updated_at < now() - interval '75 minutes';
  IF NOT FOUND THEN RAISE EXCEPTION 'Tokyo postal refresh is already running'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_tokyo_peleka_postal_refresh(
  p_run_id UUID, p_request_id UUID, p_error_message TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.tokyo_peleka_postal_refresh SET
    status = 'failed', error_message = left(p_error_message, 2000), completed_at = now(), updated_at = now()
  WHERE run_id = p_run_id AND request_id = p_request_id AND status = 'running';
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_tokyo_peleka_postal_pages(
  p_run_id UUID,
  p_request_id UUID,
  p_snapshot_id UUID,
  p_business_date DATE,
  p_expected_revision INTEGER,
  p_expected_fingerprint TEXT,
  p_pages JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_revision INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tokyo-peleka-catalog|' || p_run_id::TEXT, 0));

  PERFORM 1 FROM public.run r JOIN public.tokyo_buyback_snapshot s ON s.id = r.tokyo_snapshot_id
  WHERE r.id = p_run_id AND r.store = 'manman-akihabara' AND r.status = 'completed'
    AND r.generate_done_at IS NOT NULL AND r.tokyo_snapshot_id = p_snapshot_id
    AND s.store = r.store AND s.business_date = p_business_date
  FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Completed Tokyo run does not match'; END IF;

  PERFORM 1 FROM public.tokyo_peleka_postal_refresh
  WHERE run_id = p_run_id AND request_id = p_request_id AND status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tokyo postal refresh request does not match'; END IF;

  SELECT last_revision INTO v_revision FROM public.tokyo_peleka_catalog_revisions
  WHERE run_id = p_run_id;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog revision changed';
  END IF;
  IF p_expected_revision < 0 OR p_expected_fingerprint IS NULL
    OR p_expected_fingerprint !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Tokyo Peleka catalog identity is invalid';
  END IF;
  IF jsonb_typeof(p_pages) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Postal pages must be an array';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.generated_page
    WHERE run_id = p_run_id AND kind = 'postal'
      AND ((peleka_snapshot->>'revision')::INTEGER > p_expected_revision
        OR peleka_snapshot->>'runId' IS DISTINCT FROM p_run_id::TEXT)
  ) THEN RAISE EXCEPTION 'Existing postal pages are newer or invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pages) p WHERE
      p->>'run_id' IS DISTINCT FROM p_run_id::TEXT OR p->>'kind' IS DISTINCT FROM 'postal'
      OR p->>'status' IS DISTINCT FROM 'generated' OR NULLIF(p->>'image_key', '') IS NULL
      OR NULLIF(p->>'image_url', '') IS NULL OR NULLIF(p->>'franchise', '') IS NULL
      OR (p->>'page_index')::INTEGER < 0
      OR p->'peleka_snapshot'->>'runId' IS DISTINCT FROM p_run_id::TEXT
      OR p->'peleka_snapshot'->>'snapshotId' IS DISTINCT FROM p_snapshot_id::TEXT
      OR p->'peleka_snapshot'->>'businessDate' IS DISTINCT FROM p_business_date::TEXT
      OR (p->'peleka_snapshot'->>'revision')::INTEGER IS DISTINCT FROM p_expected_revision
      OR p->'peleka_snapshot'->>'fingerprint' IS DISTINCT FROM p_expected_fingerprint
  ) THEN RAISE EXCEPTION 'Postal page identity is invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pages) p
    GROUP BY p->>'franchise', (p->>'page_index')::INTEGER HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM public.generated_page WHERE run_id = p_run_id AND kind = 'postal'
    GROUP BY franchise, page_index HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Postal page key is duplicated'; END IF;

  UPDATE public.generated_page old SET
    page_label = fresh.page_label, card_ids = fresh.card_ids,
    layout_template_id = fresh.layout_template_id, status = fresh.status,
    display_name = fresh.display_name, peleka_snapshot = fresh.peleka_snapshot,
    image_key = fresh.image_key, image_url = fresh.image_url, error_message = NULL
  FROM jsonb_populate_recordset(NULL::public.generated_page, p_pages) fresh
  WHERE old.run_id = p_run_id AND old.kind = 'postal'
    AND old.franchise = fresh.franchise AND old.page_index = fresh.page_index;

  INSERT INTO public.generated_page (id, run_id, franchise, page_index, page_label, card_ids,
    layout_template_id, kind, status, display_name, peleka_snapshot, image_key, image_url)
  SELECT fresh.id, fresh.run_id, fresh.franchise, fresh.page_index, fresh.page_label, fresh.card_ids,
    fresh.layout_template_id, fresh.kind, fresh.status, fresh.display_name, fresh.peleka_snapshot,
    fresh.image_key, fresh.image_url
  FROM jsonb_populate_recordset(NULL::public.generated_page, p_pages) fresh
  WHERE NOT EXISTS (SELECT 1 FROM public.generated_page old
    WHERE old.run_id = p_run_id AND old.kind = 'postal'
      AND old.franchise = fresh.franchise AND old.page_index = fresh.page_index);

  BEGIN
    DELETE FROM public.generated_page old
    WHERE old.run_id = p_run_id AND old.kind = 'postal'
      AND NOT EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.generated_page, p_pages) fresh
        WHERE fresh.franchise = old.franchise AND fresh.page_index = old.page_index);
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'Postal page is referenced by a post plan and cannot be removed';
  END;

  UPDATE public.tokyo_peleka_postal_refresh SET
    status = 'succeeded', revision = p_expected_revision, fingerprint = p_expected_fingerprint,
    page_count = jsonb_array_length(p_pages), error_message = NULL,
    completed_at = now(), updated_at = now()
  WHERE run_id = p_run_id AND request_id = p_request_id AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'Tokyo postal refresh completion was lost'; END IF;
END;
$$;

REVOKE ALL ON TABLE public.tokyo_peleka_postal_refresh FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tokyo_peleka_postal_refresh TO service_role;
REVOKE ALL ON FUNCTION public.claim_tokyo_peleka_postal_refresh(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_tokyo_peleka_postal_refresh(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_tokyo_peleka_postal_pages(UUID, UUID, UUID, DATE, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tokyo_peleka_postal_refresh(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_tokyo_peleka_postal_refresh(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_tokyo_peleka_postal_pages(UUID, UUID, UUID, DATE, INTEGER, TEXT, JSONB) TO service_role;

COMMIT;
