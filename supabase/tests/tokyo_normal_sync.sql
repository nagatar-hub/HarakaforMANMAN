\set ON_ERROR_STOP on
BEGIN;
SELECT plan(8);
INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('91000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','test.xlsx',1,repeat('a',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('94000000-0000-4000-8000-000000000001','manman-akihabara','test','91000000-0000-4000-8000-000000000001');
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,product_count,offer_count,ranking_count,content_hash,started_at,completed_at)
VALUES('92000000-0000-4000-8000-000000000001','oripark','tokyo-normal-test','manual','test','applied',1,1,1,repeat('b',64),now(),now());
CREATE TEMP TABLE fixture AS SELECT jsonb_build_object(
  'id','93000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','91000000-0000-4000-8000-000000000001','checker_run_id','92000000-0000-4000-8000-000000000001',
  'checker_source_store','oripark','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,'settings','{}'::jsonb,'report','{}'::jsonb) AS snapshot,
  '[{"id":"s1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":10000,"price_high":9300,"origins":["kecak","bank","avirill"]}]'::jsonb AS products;
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture$$,'22023','latest complete Tokyo order list required','custom caller still cannot use processing imports');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000002') FROM fixture$$,'22023','active Tokyo sync lease required','wrong run cannot publish processing snapshot');
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'claimed normal sync can publish');
SELECT is((SELECT tokyo_snapshot_id::text FROM run WHERE id='94000000-0000-4000-8000-000000000001'),'93000000-0000-4000-8000-000000000001','run snapshot reference publishes atomically');
SELECT lives_ok($$INSERT INTO public.prepared_card(run_id,source_shinsoku_id,franchise,card_name,grade,list_no,tag,price_high,price_low,source,price_source)
VALUES('94000000-0000-4000-8000-000000000001','s1','Pokemon','カイ','PSA10','236/172','PSA10',9300,9300,'shinsoku','shinsoku')$$,'snapshot product enters normal prepared catalog');
SELECT throws_ok($$UPDATE public.prepared_card SET price_high=8649 WHERE run_id='94000000-0000-4000-8000-000000000001'$$,'22023','prepared product must match its Tokyo snapshot','double discount rejected at database boundary');
SELECT lives_ok($$SELECT finalize_order_list_sync('91000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',1,0,now())$$,'existing finalize completes the normal pipeline');
SELECT is((SELECT row(status,total_prepared,plan_done_at IS NOT NULL)::text FROM run WHERE id='94000000-0000-4000-8000-000000000001'),row('completed'::text,1,true)::text,'normal generate receives completed run with planned timestamp');
SELECT * FROM finish();
ROLLBACK;
