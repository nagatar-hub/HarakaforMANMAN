\set ON_ERROR_STOP on
BEGIN;
SELECT plan(6);

INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('b1000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','scoped-checker-psa.xlsx',1,repeat('b',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('b4000000-0000-4000-8000-000000000001','manman-akihabara','test','b1000000-0000-4000-8000-000000000001');

CREATE TEMP TABLE psa_fixture AS SELECT jsonb_build_object(
  'id','b3000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','b1000000-0000-4000-8000-000000000001','checker_run_id',NULL,
  'checker_source_store','manman-akihabara','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'settings','{}'::jsonb,'report',jsonb_build_object('pricing_version',2,'checker_api',jsonb_build_object(
    'api_base','https://apn.kaitori-checker.com','shop_ids','[11,44,51,54,55]'::jsonb,'condition_ids','[1,2]'::jsonb,
    'fetched_at',now(),'product_count',2,'offer_count',2
  ))) AS snapshot,
  '[{"id":"psa-1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":140000,"price_high":130000,"price_low":130000,"selected_high_source":"blue_rocket","selected_low_source":"blue_rocket","origins":[{"source":"blue_rocket","id":"1:1:0","shopId":54,"shopName":"Blue Rocket 大阪なんば日本橋店","rawPrice":140000}]},{"id":"box-1","franchise":"Pokemon","product_type":"box","name":"テラスタルフェスex","model_number":null,"source_price":40000,"price_high":37000,"price_low":35000,"selected_high_source":"blue_rocket","selected_low_source":"blue_rocket","origins":[{"source":"blue_rocket","id":"21461:2:0","shopId":51,"shopName":"Blue Rocket 秋葉原LAOX店","rawPrice":40000}]}]'::jsonb AS products;

SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,condition_ids}','[1,2,3]'),products,'b4000000-0000-4000-8000-000000000001') FROM psa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','PSA10 scope does not admit unrelated conditions');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot #- '{report,checker_api,condition_ids}',products,'b4000000-0000-4000-8000-000000000001') FROM psa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','missing condition evidence still fails closed');
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'b4000000-0000-4000-8000-000000000001') FROM psa_fixture$$,
  'PSA10 and BOX from all five Blue Rocket shops can publish together');
SELECT is((SELECT count(*)::integer FROM public.tokyo_buyback_product WHERE snapshot_id='b3000000-0000-4000-8000-000000000001'),
  2,'both PSA10 and BOX products persist in the same immutable snapshot');
SELECT is((SELECT origins #>> '{0,shopId}' FROM public.tokyo_buyback_product WHERE snapshot_id='b3000000-0000-4000-8000-000000000001' AND id='psa-1'),
  '54','PSA10 price retains its actual Blue Rocket branch ID');
SELECT is((SELECT origins #>> '{0,shopName}' FROM public.tokyo_buyback_product WHERE snapshot_id='b3000000-0000-4000-8000-000000000001' AND id='psa-1'),
  'Blue Rocket 大阪なんば日本橋店','PSA10 price retains its actual Blue Rocket branch name');
SELECT * FROM finish();
ROLLBACK;
