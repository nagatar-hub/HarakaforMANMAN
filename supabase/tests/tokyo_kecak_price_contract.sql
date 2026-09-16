\set ON_ERROR_STOP on
BEGIN;
SELECT plan(6);
INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('91000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','test.xlsx',1,repeat('a',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('94000000-0000-4000-8000-000000000001','manman-akihabara','test','91000000-0000-4000-8000-000000000001');
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,product_count,offer_count,ranking_count,content_hash,started_at,completed_at)
VALUES('92000000-0000-4000-8000-000000000001','oripark','tokyo-kecak-price-test','manual','test','applied',1,1,1,repeat('b',64),now(),now());
CREATE TEMP TABLE fixture AS SELECT jsonb_build_object(
  'id','93000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','91000000-0000-4000-8000-000000000001','checker_run_id','92000000-0000-4000-8000-000000000001',
  'checker_source_store','oripark','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'settings','{}'::jsonb,'report','{"price_sources":{"IAP123":{"source":"shinsoku","source_id":"IAP123","price":70000},"IAP124":{"source":"shinsoku","source_id":"IAP124","price":50000}}}'::jsonb) AS snapshot,
  '[{"id":"IAP123","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":70000,"price_high":67000,"origins":[{"source":"kecak","id":"k1","sourcePrice":1}]},
    {"id":"IAP124","franchise":"Pokemon","product_type":"psa","name":"イーブイ","model_number":"062/SV-P","source_price":50000,"price_high":48000,"origins":[{"source":"kecak","id":"k2","sourcePrice":1}]}]'::jsonb AS products;
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'Shinsoku-priced candidate IDs publish');
SELECT is((SELECT source_price FROM public.tokyo_buyback_product WHERE snapshot_id='93000000-0000-4000-8000-000000000001' AND id='IAP123'),70000::numeric,'Shinsoku raw price survives snapshot publication');
SELECT lives_ok($$INSERT INTO public.prepared_card(run_id,source_shinsoku_id,franchise,card_name,grade,list_no,tag,price_high,price_low,source,price_source)
VALUES('94000000-0000-4000-8000-000000000001','IAP123','Pokemon','カイ','PSA10','236/172','カイ',67000,67000,'shinsoku','shinsoku'),
('94000000-0000-4000-8000-000000000001','IAP124','Pokemon','イーブイ','PSA10','062/SV-P','イーブイ',48000,48000,'shinsoku','shinsoku')$$,'existing prepared source labels allow both Shinsoku IDs');
SELECT throws_ok($$UPDATE public.prepared_card SET price_high=93000 WHERE run_id='94000000-0000-4000-8000-000000000001' AND source_shinsoku_id='IAP123'$$,'22023','prepared product must match its Tokyo snapshot','prepared cannot silently replace the chosen Shinsoku price');
SELECT lives_ok($$SELECT finalize_order_list_sync('91000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',2,0,now())$$,'normal pipeline finalizes both products');
SELECT is((SELECT row(status,total_prepared,tokyo_snapshot_id)::text FROM public.run WHERE id='94000000-0000-4000-8000-000000000001'),row('completed'::text,2,'93000000-0000-4000-8000-000000000001'::uuid)::text,'completed run retains both Shinsoku-priced products');
SELECT * FROM finish();
ROLLBACK;
