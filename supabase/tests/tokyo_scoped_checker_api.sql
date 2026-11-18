\set ON_ERROR_STOP on
BEGIN;
SELECT plan(18);

INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('a1000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','scoped-checker.xlsx',1,repeat('a',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('a4000000-0000-4000-8000-000000000001','manman-akihabara','test','a1000000-0000-4000-8000-000000000001');

CREATE TEMP TABLE scoped_fixture AS SELECT jsonb_build_object(
  'id','a3000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','a1000000-0000-4000-8000-000000000001','checker_run_id',NULL,
  'checker_source_store','manman-akihabara','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'settings','{}'::jsonb,'report',jsonb_build_object('pricing_version',2,'checker_api',jsonb_build_object(
    'api_base','https://apn.kaitori-checker.com','shop_ids','[11,44,51,54,55]'::jsonb,'condition_ids','[2]'::jsonb,
    'fetched_at',now(),'product_count',1,'offer_count',2,
    'shops','[{"shop_id":11,"shop_name":"秋葉原","offer_count":1,"error":null},{"shop_id":44,"offer_count":0,"error":"HTTP 503"},{"shop_id":51,"shop_name":"LAOX","offer_count":1,"error":null},{"shop_id":54,"offer_count":0,"error":null},{"shop_id":55,"offer_count":0,"error":null}]'::jsonb
  ))) AS snapshot,
  '[{"id":"box-1","franchise":"Pokemon","product_type":"box","name":"テラスタルフェスex","model_number":null,"source_price":40000,"price_high":37000,"price_low":35000,"selected_high_source":"blue_rocket","selected_low_source":"blue_rocket","origins":[{"source":"blue_rocket","id":"21461:2:0","shopId":51,"shopName":"LAOX","rawPrice":40000}]}]'::jsonb AS products;

SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM scoped_fixture$$,
  '22023','latest complete Tokyo order list required','unclaimed caller cannot publish a processing order list');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot || '{"store":"manman"}',products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo store required','other stores cannot use Tokyo publication');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'a4000000-0000-4000-8000-000000000002') FROM scoped_fixture$$,
  '22023','active Tokyo sync lease required','wrong run cannot publish');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot - 'report',products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo scoped checker API evidence required','live path requires API evidence');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[11]'),products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo scoped checker API evidence required','single-shop evidence cannot silently omit the other Blue Rocket shops');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,condition_ids}','[1]'),products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo scoped checker API evidence required','checker API evidence must retain BOX coverage');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot || '{"checker_source_store":"oripark"}',products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo scoped checker API evidence required','live API evidence cannot be attributed to another tenant');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,api_base}','"https://example.com"'),products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','Tokyo scoped checker API evidence required','unexpected API origin is rejected');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,fetched_at}',to_jsonb(now()-interval '1 second')),products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','invalid checker API fetch time','cached API evidence from before generation is rejected');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,fetched_at}',to_jsonb(now()+interval '1 hour')),products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','invalid checker API fetch time','future API evidence is rejected');

UPDATE public.order_list_import SET heartbeat_at=now()-interval '6 minutes' WHERE id='a1000000-0000-4000-8000-000000000001';
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  '22023','active Tokyo sync lease required','expired lease still prevents publication');
UPDATE public.order_list_import SET heartbeat_at=now() WHERE id='a1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'a4000000-0000-4000-8000-000000000001') FROM scoped_fixture$$,
  'fresh shop API evidence publishes without a global checker run and with a single shop failure');
SELECT is((SELECT tokyo_snapshot_id::text FROM public.run WHERE id='a4000000-0000-4000-8000-000000000001'),
  'a3000000-0000-4000-8000-000000000001','snapshot reference publishes atomically with the run');
SELECT is((SELECT origins #>> '{0,shopId}' FROM public.tokyo_buyback_product WHERE snapshot_id='a3000000-0000-4000-8000-000000000001'),
  '51','winning Blue Rocket store provenance is retained');
SELECT ok((SELECT checker_run_id IS NULL FROM public.tokyo_buyback_snapshot WHERE id='a3000000-0000-4000-8000-000000000001'),
  'no fabricated global checker run is required');
SELECT ok(has_function_privilege('service_role','public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)','EXECUTE'),
  'service role may publish');
SELECT ok(NOT has_function_privilege('anon','public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)','EXECUTE'),
  'anonymous callers cannot publish');
SELECT ok(NOT has_function_privilege('authenticated','public.publish_tokyo_buyback_snapshot(jsonb,jsonb,uuid)','EXECUTE'),
  'browser users cannot publish directly');
SELECT * FROM finish();
ROLLBACK;
