\set ON_ERROR_STOP on
BEGIN;
SELECT plan(22);

INSERT INTO public.kaitori_checker_sync_run (
  id, store, request_key, trigger, claim_token, status,
  product_count, offer_count, ranking_count, content_hash,
  started_at, completed_at
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  'oripark', 'sql-kc-expired', 'scheduler', 'expired-token', 'applied',
  1, 1, 1, repeat('e', 64),
  clock_timestamp() - INTERVAL '91 days',
  clock_timestamp() - INTERVAL '91 days'
);
INSERT INTO public.kaitori_checker_product_snapshot (
  run_id, store, source_product_id, category, name
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  'oripark', 1000, 'Pokemon', 'Expired card'
);
INSERT INTO public.kaitori_checker_offer_snapshot (
  run_id, store, source_product_id, buy_price, shop_name
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  'oripark', 1000, 100, 'Expired shop'
);
INSERT INTO public.kaitori_checker_ranking_snapshot (
  run_id, store, ranking_type, category, rank, source_product_id, product_name
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  'oripark', 'trend', 'Pokemon', 1, 1000, 'Expired card'
);

INSERT INTO public.kaitori_checker_sync_run (
  store, request_key, trigger, claim_token, status, started_at, updated_at
) VALUES (
  'stale-test', 'sql-kc-stale', 'scheduler', 'stale-token', 'running',
  clock_timestamp() - INTERVAL '5 hours', clock_timestamp() - INTERVAL '5 hours'
);

DO $test$
DECLARE
  v_claim JSONB;
BEGIN
  v_claim := public.claim_kaitori_checker_sync(
    'stale-test', 'sql-kc-after-stale', 'scheduler', 'new-token'
  );
  IF v_claim ->> 'action' <> 'start_job'
    OR (SELECT status FROM public.kaitori_checker_sync_run
        WHERE store = 'stale-test' AND request_key = 'sql-kc-stale') <> 'failed'
    OR (SELECT completed_at FROM public.kaitori_checker_sync_run
        WHERE store = 'stale-test' AND request_key = 'sql-kc-stale') IS NULL THEN
    RAISE EXCEPTION 'stale running sync was not recovered before a new claim';
  END IF;
END
$test$;
SELECT pass('claim recovers a running sync older than four hours before starting a new request');

SELECT is(
  public.claim_kaitori_checker_sync(
    'oripark', 'sql-kc-1', 'manual', 'oripark-token'
  )->>'action',
  'start_job',
  'first claim starts a run'
);

SELECT is(
  public.claim_kaitori_checker_sync(
    'oripark', 'sql-kc-1', 'manual', 'oripark-token'
  )->>'action',
  'resume_job',
  'same request key and claim token resume idempotently'
);

SELECT is(
  public.claim_kaitori_checker_sync(
    'oripark', 'sql-kc-1', 'manual', 'wrong-token'
  )->>'action',
  'already_running',
  'same request key with another claim token cannot resume'
);

SELECT is(
  public.claim_kaitori_checker_sync(
    'oripark', 'sql-kc-blocked', 'scheduler', 'blocked-token'
  )->>'action',
  'already_running',
  'a different request cannot start beside a running store job'
);

SELECT is(
  public.claim_kaitori_checker_sync(
    'manman', 'sql-kc-manman', 'manual', 'manman-token'
  )->>'action',
  'start_job',
  'another store may run independently'
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO public.kaitori_checker_sync_run (
      store, request_key, trigger, claim_token, status, started_at
    ) VALUES (
      'oripark', 'sql-kc-direct-race', 'manual', 'direct-token',
      'running', clock_timestamp()
    );
    RAISE EXCEPTION 'second running Oripark sync unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('database constraint permits only one running sync per store');

DO $test$
DECLARE
  v_run_id UUID := (
    SELECT id FROM public.kaitori_checker_sync_run
    WHERE store = 'oripark' AND request_key = 'sql-kc-1'
  );
BEGIN
  BEGIN
    INSERT INTO public.kaitori_checker_product_snapshot (
      run_id, store, source_product_id, category, name
    ) VALUES (v_run_id, 'manman', 99, 'Pokemon', 'Cross-store card');
    RAISE EXCEPTION 'cross-store product unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$test$;
SELECT pass('snapshot foreign key rejects a cross-store run reference');

SELECT is(
  (public.update_kaitori_checker_progress(
    (SELECT id FROM public.kaitori_checker_sync_run
     WHERE store = 'oripark' AND request_key = 'sql-kc-1'),
    'oripark', 'oripark-token', 4
  )->>'progress_page')::INT,
  4,
  'matching claim token advances progress'
);

DO $test$
DECLARE
  v_run_id UUID := (
    SELECT id FROM public.kaitori_checker_sync_run
    WHERE store = 'oripark' AND request_key = 'sql-kc-1'
  );
BEGIN
  BEGIN
    PERFORM public.update_kaitori_checker_progress(
      v_run_id, 'oripark', 'wrong-token', 5
    );
    RAISE EXCEPTION 'wrong token unexpectedly updated progress';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM public.finalize_kaitori_checker_sync(
      v_run_id, 'oripark', 'wrong-token', 1, 1, 1,
      repeat('f', 64), clock_timestamp()
    );
    RAISE EXCEPTION 'wrong token unexpectedly finalized';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM public.fail_kaitori_checker_sync(
      v_run_id, 'oripark', 'wrong-token', 'must be fenced', clock_timestamp()
    );
    RAISE EXCEPTION 'wrong token unexpectedly failed run';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END
$test$;
SELECT pass('another claim token cannot update, finalize, or fail a run');

INSERT INTO public.kaitori_checker_product_snapshot (
  run_id, store, source_product_id, category, name
)
SELECT id, store, 101, 'Pokemon', 'Generation 1 card'
FROM public.kaitori_checker_sync_run
WHERE store = 'oripark' AND request_key = 'sql-kc-1';

INSERT INTO public.kaitori_checker_offer_snapshot (
  run_id, store, source_product_id, shop_id, condition_id, edition_id,
  buy_price, shop_name
)
SELECT id, store, 101, 1, 0, 0, 1000, 'Test shop'
FROM public.kaitori_checker_sync_run
WHERE store = 'oripark' AND request_key = 'sql-kc-1';

INSERT INTO public.kaitori_checker_ranking_snapshot (
  run_id, store, ranking_type, category, rank, source_product_id, product_name,
  shop_change_count
)
SELECT id, store, 'trend', 'Pokemon', 1, 101, 'Generation 1 card', 3
FROM public.kaitori_checker_sync_run
WHERE store = 'oripark' AND request_key = 'sql-kc-1';

DO $test$
DECLARE
  v_run_id UUID := (
    SELECT id FROM public.kaitori_checker_sync_run
    WHERE store = 'oripark' AND request_key = 'sql-kc-1'
  );
BEGIN
  BEGIN
    PERFORM public.finalize_kaitori_checker_sync(
      v_run_id, 'oripark', 'oripark-token', 2, 1, 1,
      repeat('a', 64), clock_timestamp()
    );
    RAISE EXCEPTION 'mismatched counts unexpectedly finalized';
  EXCEPTION WHEN SQLSTATE '22000' THEN
    NULL;
  END;
END
$test$;
SELECT pass('finalize rejects counts that do not match stored snapshots');

SELECT is(
  public.finalize_kaitori_checker_sync(
    (SELECT id FROM public.kaitori_checker_sync_run
     WHERE store = 'oripark' AND request_key = 'sql-kc-1'),
    'oripark', 'oripark-token', 1, 1, 1, repeat('a', 64), clock_timestamp()
  )->>'status',
  'applied',
  'matching snapshots finalize atomically'
);

SELECT is(
  (SELECT name FROM public.kaitori_checker_latest_product
   WHERE store = 'oripark' AND source_product_id = 101),
  'Generation 1 card',
  'latest product view exposes the applied generation'
);

SELECT is(
  (SELECT shop_change_count FROM public.kaitori_checker_latest_ranking
   WHERE store = 'oripark' AND source_product_id = 101),
  3,
  'latest ranking retains the source shop change count'
);

SELECT is(
  (SELECT count(*)::INT FROM public.kaitori_checker_sync_run
   WHERE id = '60000000-0000-4000-8000-000000000001'),
  0,
  'finalize removes terminal runs older than 90 days'
);

SELECT is(
  (SELECT count(*)::INT FROM public.kaitori_checker_ranking_snapshot
   WHERE run_id = '60000000-0000-4000-8000-000000000001'),
  0,
  'expired run cleanup cascades to its ranking history'
);

SELECT is(
  public.fail_kaitori_checker_sync(
    (SELECT id FROM public.kaitori_checker_sync_run
     WHERE store = 'manman' AND request_key = 'sql-kc-manman'),
    'manman', 'manman-token', 'expected SQL test failure', clock_timestamp()
  )->>'status',
  'failed',
  'running sync can fail without changing another store'
);

DO $test$
DECLARE
  v_generation INT;
  v_run_id UUID;
BEGIN
  FOR v_generation IN 2..3 LOOP
    v_run_id := (
      public.claim_kaitori_checker_sync(
        'oripark', 'sql-kc-' || v_generation, 'scheduler',
        'generation-token-' || v_generation
      )->>'run_id'
    )::UUID;

    INSERT INTO public.kaitori_checker_product_snapshot (
      run_id, store, source_product_id, category, name
    ) VALUES (
      v_run_id, 'oripark', 100 + v_generation, 'Pokemon',
      'Generation ' || v_generation || ' card'
    );
    INSERT INTO public.kaitori_checker_offer_snapshot (
      run_id, store, source_product_id, shop_id, condition_id, edition_id,
      buy_price, shop_name
    ) VALUES (
      v_run_id, 'oripark', 100 + v_generation, 1, 0, 0,
      1000 + v_generation, 'Test shop'
    );
    INSERT INTO public.kaitori_checker_ranking_snapshot (
      run_id, store, ranking_type, category, rank, source_product_id, product_name
    ) VALUES (
      v_run_id, 'oripark', 'trend', 'Pokemon', 1, 100 + v_generation,
      'Generation ' || v_generation || ' card'
    );
    PERFORM public.finalize_kaitori_checker_sync(
      v_run_id, 'oripark', 'generation-token-' || v_generation,
      1, 1, 1, repeat(v_generation::TEXT, 64),
      clock_timestamp() + make_interval(secs => v_generation)
    );
  END LOOP;
END
$test$;
SELECT pass('two subsequent generations finalize');

SELECT is(
  (SELECT count(*)::INT
   FROM public.kaitori_checker_product_snapshot AS product
   JOIN public.kaitori_checker_sync_run AS run ON run.id = product.run_id
   WHERE run.request_key = 'sql-kc-1'),
  0,
  'finalize removes product data older than the latest two applied generations'
);

SELECT is(
  (SELECT count(*)::INT
   FROM public.kaitori_checker_ranking_snapshot AS ranking
   JOIN public.kaitori_checker_sync_run AS run ON run.id = ranking.run_id
   WHERE run.request_key = 'sql-kc-1'),
  1,
  'ranking history is retained after product cleanup'
);

SELECT is(
  (SELECT name FROM public.kaitori_checker_latest_product
   WHERE store = 'oripark' AND source_product_id = 103),
  'Generation 3 card',
  'latest view advances to the newest applied generation'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.kaitori_checker_sync_run', 'SELECT'),
  'anonymous role cannot read sync state'
);

SELECT * FROM finish();
ROLLBACK;
