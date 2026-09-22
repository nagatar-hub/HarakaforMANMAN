\set ON_ERROR_STOP on
BEGIN;
SELECT plan(14);
INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete)
VALUES('81000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'applied','test.xlsx',1,repeat('a',64),'test',true,true);
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,product_count,offer_count,ranking_count,content_hash,started_at,completed_at)
VALUES('82000000-0000-4000-8000-000000000001','oripark','tokyo-test','manual','test','applied',1,1,1,repeat('b',64),now(),now());
CREATE TEMP TABLE fixture AS SELECT jsonb_build_object(
  'id','83000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','81000000-0000-4000-8000-000000000001','checker_run_id','82000000-0000-4000-8000-000000000001',
  'checker_source_store','oripark','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,'settings','{}'::jsonb,'report','{}'::jsonb) AS snapshot,
  '[{"id":"s1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":10000,"price_high":9000,"origins":["kecak","bank","avirill"]},{"id":"s2","franchise":"ONE PIECE","product_type":"psa","name":"別商材","source_price":10000,"price_high":9000,"origins":["bank"]}]'::jsonb AS products;
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture$$,'publish verified Tokyo snapshot');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot || '{"store":"manman"}',products) FROM fixture$$,'22023','Tokyo store required','Osaka cannot publish');
INSERT INTO public.custom_buyback_sheet(id,store,name,franchise,product_type,kind,catalog_source,tokyo_snapshot_id,price_business_date,display_date)
VALUES('84000000-0000-4000-8000-000000000001','manman-akihabara','Tokyo','Pokemon','psa','store','shinsoku','83000000-0000-4000-8000-000000000001',current_date,current_date);
SELECT lives_ok($$SELECT add_custom_buyback_shinsoku_items('84000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY['s1'])$$,'add matched Shinsoku product');
SELECT is((SELECT final_price_high FROM custom_buyback_item WHERE sheet_id='84000000-0000-4000-8000-000000000001'),9000::numeric,'discount is applied once');
SELECT throws_ok($$SELECT add_custom_buyback_shinsoku_items('84000000-0000-4000-8000-000000000001','manman',ARRAY['s1'])$$,'P0002','sheet not found','Osaka cannot access Tokyo sheet');
SELECT throws_ok($$SELECT add_custom_buyback_shinsoku_items('84000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY['s2'])$$,'22023','incompatible snapshot products','foreign franchise rejected');
SELECT throws_ok($$SELECT add_custom_buyback_shinsoku_items('84000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY['s1','s1'])$$,'22023','unique product IDs required','duplicate IDs rejected');
SELECT lives_ok($$SELECT clone_custom_buyback_sheet('84000000-0000-4000-8000-000000000001','manman-akihabara','clone','test')$$,'clone preserves Shinsoku provenance');
SELECT is((SELECT count(*) FROM custom_buyback_item WHERE source_shinsoku_id='s1'),2::bigint,'clone has same source ID');
UPDATE fixture SET snapshot=snapshot || jsonb_build_object('id','83000000-0000-4000-8000-000000000002','fetched_at',now()+interval '1 second'), products='[{"id":"s1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":12000,"price_high":10800,"origins":["bank"]}]';
SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture;
SELECT refresh_custom_buyback_shinsoku_prices('84000000-0000-4000-8000-000000000001','manman-akihabara','83000000-0000-4000-8000-000000000002',false);
SELECT is((SELECT final_price_high FROM custom_buyback_item WHERE sheet_id='84000000-0000-4000-8000-000000000001'),10800::numeric,'refresh uses selected new snapshot price');
UPDATE fixture SET snapshot=snapshot || jsonb_build_object('id','83000000-0000-4000-8000-000000000003','fetched_at',now()+interval '2 seconds'),products=jsonb_set(products,'{0,id}','"absent"');
SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture;
SELECT throws_ok($$SELECT refresh_custom_buyback_shinsoku_prices('84000000-0000-4000-8000-000000000001','manman-akihabara','83000000-0000-4000-8000-000000000003',false)$$,'22023','missing or incompatible products; no prices changed','missing latest product prevents partial update');
SELECT is((SELECT final_price_high FROM custom_buyback_item WHERE sheet_id='84000000-0000-4000-8000-000000000001'),10800::numeric,'failed refresh preserves last valid price');
SELECT lives_ok($$DELETE FROM kaitori_checker_sync_run WHERE id='82000000-0000-4000-8000-000000000001'$$,'checker retention can remove run metadata without blocking future tracking');
SELECT is((SELECT checker_run_id::text FROM tokyo_buyback_snapshot WHERE id='83000000-0000-4000-8000-000000000001'),'82000000-0000-4000-8000-000000000001','Tokyo snapshot retains immutable source provenance after retention');
SELECT * FROM finish();
ROLLBACK;
