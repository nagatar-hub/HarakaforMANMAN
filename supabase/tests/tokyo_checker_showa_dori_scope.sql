\set ON_ERROR_STOP on
BEGIN;
SELECT plan(11);

INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('c1000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','showa-dori.xlsx',1,repeat('c',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('c4000000-0000-4000-8000-000000000001','manman-akihabara','test','c1000000-0000-4000-8000-000000000001');

CREATE TEMP TABLE showa_fixture AS SELECT jsonb_build_object(
  'id','c3000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','c1000000-0000-4000-8000-000000000001','checker_run_id',NULL,
  'checker_source_store','manman-akihabara','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'settings','{}'::jsonb,'report',jsonb_build_object('pricing_version',2,'checker_api',jsonb_build_object(
    'api_base','https://apn.kaitori-checker.com','shop_ids','[11]'::jsonb,'condition_ids','[1,2]'::jsonb,
    'fetched_at',now(),'product_count',2,'offer_count',2
  ))) AS snapshot,
  '[{"id":"psa-1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":140000,"price_high":130000,"price_low":130000,"selected_high_source":"blue_rocket","selected_low_source":"blue_rocket","origins":[{"source":"blue_rocket","id":"1:1:0","shopId":11,"shopName":"Blue Rocket（ブルロケ）昭和通り店","rawPrice":140000}]},{"id":"box-1","franchise":"Pokemon","product_type":"box","name":"テラスタルフェスex","model_number":null,"source_price":40000,"price_high":37000,"price_low":35000,"selected_high_source":"blue_rocket","selected_low_source":"blue_rocket","origins":[{"source":"blue_rocket","id":"21461:2:0","shopId":11,"shopName":"Blue Rocket（ブルロケ）昭和通り店","rawPrice":40000}]}]'::jsonb AS products;

SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot #- '{report,checker_api,shop_ids}',products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','missing shop scope fails closed');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[44]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','postal branch alone is not the Showa-dori scope');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[11,44]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','arbitrary partial multi-shop scopes are rejected');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','["11"]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','shop evidence requires numeric IDs');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[11,11]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','duplicate IDs do not satisfy the configured scope');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[73]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  '22023','Tokyo scoped checker API evidence required','Suehirocho alone is not the two-branch scope');
SAVEPOINT two_branches;
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(jsonb_set(snapshot,'{report,checker_api,shop_ids}','[11,73]'),products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  'Showa-dori and Suehirocho may publish PSA10 and BOX together');
ROLLBACK TO two_branches;
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'c4000000-0000-4000-8000-000000000001') FROM showa_fixture$$,
  'Showa-dori-only PSA10 and BOX publish with the active sync lease');
SELECT is((SELECT count(*)::integer FROM public.tokyo_buyback_product WHERE snapshot_id='c3000000-0000-4000-8000-000000000001'),
  2,'both product types persist in the Showa-dori snapshot');
SELECT ok((SELECT bool_and(origins #>> '{0,shopId}' = '11') FROM public.tokyo_buyback_product WHERE snapshot_id='c3000000-0000-4000-8000-000000000001'),
  'PSA10 and BOX retain Showa-dori branch provenance');

UPDATE public.order_list_import SET status='applied' WHERE id='c1000000-0000-4000-8000-000000000001';
UPDATE showa_fixture SET snapshot=jsonb_set(jsonb_set(jsonb_set(snapshot || jsonb_build_object(
  'id','c3000000-0000-4000-8000-000000000002','fetched_at',now()+interval '1 millisecond'),
  '{report,checker_api,fetched_at}',to_jsonb(now()+interval '1 millisecond')),
  '{report,checker_api,condition_ids}','[2]'),'{report,checker_api,product_count}','1');
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,jsonb_build_array(products->1)) FROM showa_fixture$$,
  'Showa-dori BOX-only evidence remains compatible with the existing custom publication path');
SELECT * FROM finish();
ROLLBACK;
