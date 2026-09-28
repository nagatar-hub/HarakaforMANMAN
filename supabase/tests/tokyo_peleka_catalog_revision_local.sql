\set ON_ERROR_STOP on

CREATE TABLE public.run (
  id UUID PRIMARY KEY,
  store TEXT NOT NULL,
  tokyo_snapshot_id UUID,
  status TEXT NOT NULL,
  generate_done_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.tokyo_buyback_snapshot (
  id UUID PRIMARY KEY,
  store TEXT NOT NULL,
  business_date DATE NOT NULL
);
CREATE TABLE public.generated_page (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.run(id),
  status TEXT NOT NULL,
  card_ids UUID[] NOT NULL
);
CREATE TABLE public.prepared_card (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.run(id),
  source_shinsoku_id TEXT,
  franchise TEXT NOT NULL,
  card_name TEXT NOT NULL,
  grade TEXT,
  list_no TEXT,
  image_url TEXT,
  alt_image_url TEXT,
  tag TEXT,
  price_high INTEGER,
  price_low INTEGER
);

\i /tmp/20260928000001_tokyo_peleka_catalog_revisions.sql

INSERT INTO public.tokyo_buyback_snapshot VALUES
  ('10000000-0000-4000-8000-000000000001', 'manman-akihabara', '2026-09-27'),
  ('20000000-0000-4000-8000-000000000001', 'manman-akihabara', '2026-09-28');
INSERT INTO public.run VALUES
  ('10000000-0000-4000-8000-000000000002', 'manman-akihabara', '10000000-0000-4000-8000-000000000001', 'completed', '2026-09-27T02:06:00Z', '2026-09-27T02:05:00Z'),
  ('20000000-0000-4000-8000-000000000002', 'manman-akihabara', '20000000-0000-4000-8000-000000000001', 'running', NULL, '2026-09-28T02:05:00Z'),
  ('30000000-0000-4000-8000-000000000002', 'other-store', NULL, 'completed', '2026-09-27T02:06:00Z', '2026-09-27T02:05:00Z');
INSERT INTO public.prepared_card VALUES
  ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000002', 'source-1', 'ONE PIECE', 'チョッパー', 'PSA10', 'EB01-006', 'https://example.test/old.png', NULL, 'selected', 1200, 1000),
  ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002', NULL, 'ONE PIECE', '手動カード', NULL, NULL, 'https://example.test/manual.png', NULL, NULL, 1000, 900),
  ('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000002', 'foreign', 'ONE PIECE', '別店舗', 'PSA10', NULL, 'https://example.test/foreign.png', NULL, NULL, 1000, 900);
INSERT INTO public.generated_page VALUES
  ('10000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000002', 'generated', ARRAY[
    '10000000-0000-4000-8000-000000000010'::UUID,
    '10000000-0000-4000-8000-000000000011'::UUID
  ]),
  ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', 'generated', ARRAY[]::UUID[]),
  ('20000000-0000-4000-8000-000000000020', '20000000-0000-4000-8000-000000000002', 'generated', ARRAY[]::UUID[]);

DO $$
DECLARE
  payload JSONB;
BEGIN
  payload := public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
  IF (payload->>'revision')::INTEGER <> 1
    OR jsonb_array_length(payload->'cards') <> 1
    OR payload->>'generatedAt' <> '2026-09-27T02:05:00+00:00'
    OR payload->'cards'->0->>'source_shinsoku_id' <> 'source-1' THEN
    RAISE EXCEPTION 'first snapshot or manual-card exclusion is incorrect: %', payload;
  END IF;

  UPDATE public.prepared_card SET price_high = 1300
  WHERE id = '10000000-0000-4000-8000-000000000010';
  payload := public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
  IF (payload->>'revision')::INTEGER <> 2
    OR (payload->'cards'->0->>'price_high')::INTEGER <> 1300 THEN
    RAISE EXCEPTION 'edited snapshot did not receive the next revision: %', payload;
  END IF;

  BEGIN
    UPDATE public.generated_page SET status = 'pending'
    WHERE id = '10000000-0000-4000-8000-000000000020';
    PERFORM public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'pending page was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog pages are not fully generated' THEN RAISE; END IF;
  END;

  UPDATE public.generated_page SET status = 'pending'
  WHERE id = '10000000-0000-4000-8000-000000000020';
  payload := public.allocate_tokyo_peleka_catalog_revision(
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000020'
  );
  IF (payload->>'revision')::INTEGER <> 3
    OR (payload->'cards'->0->>'price_high')::INTEGER <> 1300 THEN
    RAISE EXCEPTION 'pending regenerating page was not snapshot correctly: %', payload;
  END IF;
  UPDATE public.generated_page SET status = 'generated'
  WHERE id = '10000000-0000-4000-8000-000000000020';

  UPDATE public.generated_page SET status = 'pending'
  WHERE id IN (
    '10000000-0000-4000-8000-000000000020',
    '10000000-0000-4000-8000-000000000021'
  );
  BEGIN
    PERFORM public.allocate_tokyo_peleka_catalog_revision(
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000020'
    );
    RAISE EXCEPTION 'another pending page was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog pages are not fully generated' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.allocate_tokyo_peleka_catalog_revision(
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000021'
    );
    RAISE EXCEPTION 'second concurrent pending page was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog pages are not fully generated' THEN RAISE; END IF;
  END;

  IF (SELECT last_revision FROM public.tokyo_peleka_catalog_revisions
      WHERE run_id = '10000000-0000-4000-8000-000000000002') <> 3 THEN
    RAISE EXCEPTION 'rejected concurrent regenerations advanced the revision';
  END IF;

  UPDATE public.generated_page SET status = 'failed'
  WHERE id IN (
    '10000000-0000-4000-8000-000000000020',
    '10000000-0000-4000-8000-000000000021'
  );
  UPDATE public.generated_page SET status = 'pending'
  WHERE id = '10000000-0000-4000-8000-000000000020';
  payload := public.allocate_tokyo_peleka_catalog_revision(
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000020'
  );
  IF (payload->>'revision')::INTEGER <> 4 THEN
    RAISE EXCEPTION 'first failed page retry did not recover: %', payload;
  END IF;
  UPDATE public.generated_page SET status = 'generated'
  WHERE id = '10000000-0000-4000-8000-000000000020';

  UPDATE public.generated_page SET status = 'pending'
  WHERE id = '10000000-0000-4000-8000-000000000021';
  payload := public.allocate_tokyo_peleka_catalog_revision(
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000021'
  );
  IF (payload->>'revision')::INTEGER <> 5 THEN
    RAISE EXCEPTION 'second failed page retry did not recover: %', payload;
  END IF;
  UPDATE public.generated_page SET status = 'generated'
  WHERE id = '10000000-0000-4000-8000-000000000021';

  BEGIN
    UPDATE public.generated_page SET card_ids = card_ids || '30000000-0000-4000-8000-000000000010'::UUID
    WHERE id = '10000000-0000-4000-8000-000000000020';
    PERFORM public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'foreign-store card was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog contains missing or foreign-store cards' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.generated_page SET card_ids = card_ids || card_ids[1]
    WHERE id = '10000000-0000-4000-8000-000000000020';
    PERFORM public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'duplicate card was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog contains duplicate cards' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.generated_page SET status = 'failed'
    WHERE id = '20000000-0000-4000-8000-000000000020';
    PERFORM public.allocate_tokyo_peleka_catalog_revision('20000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'failed page in initial run was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Tokyo Peleka catalog pages are not fully generated' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE public.generated_page SET status = 'generated'
    WHERE id = '20000000-0000-4000-8000-000000000020';
    PERFORM public.allocate_tokyo_peleka_catalog_revision('20000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'ordinary empty initial generation was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Initial Tokyo Peleka catalog must not be empty' THEN RAISE; END IF;
  END;

  UPDATE public.generated_page SET card_ids = ARRAY[]::UUID[]
  WHERE id = '10000000-0000-4000-8000-000000000020';
  payload := public.allocate_tokyo_peleka_catalog_revision('10000000-0000-4000-8000-000000000002');
  IF (payload->>'revision')::INTEGER <> 6 OR jsonb_array_length(payload->'cards') <> 0 THEN
    RAISE EXCEPTION 'intentional last-item removal was not revisioned: %', payload;
  END IF;
END;
$$;

SELECT 'Haraka Tokyo catalog revision contract passed' AS result;
