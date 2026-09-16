\set ON_ERROR_STOP on
BEGIN;
SELECT plan(26);
INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete,heartbeat_at)
VALUES('91000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'processing','test.xlsx',1,repeat('a',64),'test',true,true,now());
INSERT INTO public.run(id,store,triggered_by,order_list_import_id)
VALUES('94000000-0000-4000-8000-000000000001','manman-akihabara','test','91000000-0000-4000-8000-000000000001');
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,product_count,offer_count,ranking_count,content_hash,started_at,completed_at)
VALUES('92000000-0000-4000-8000-000000000001','oripark','tokyo-normal-test','manual','test','applied',1,1,1,repeat('b',64),now(),now());
UPDATE public.kaitori_checker_sync_run SET created_at=now()-interval '1 hour'
WHERE id='92000000-0000-4000-8000-000000000001';
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,started_at)
VALUES('92000000-0000-4000-8000-000000000002','oripark','tokyo-normal-running-test','manual','test-running','running',now());
CREATE TEMP TABLE fixture AS SELECT jsonb_build_object(
  'id','93000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','91000000-0000-4000-8000-000000000001','checker_run_id','92000000-0000-4000-8000-000000000001',
  'checker_source_store','oripark','fetched_at',now(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,'settings','{}'::jsonb,'report','{}'::jsonb) AS snapshot,
  '[{"id":"s1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":10000,"price_high":9300,"origins":["kecak","bank","avirill"]}]'::jsonb AS products;
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture$$,'22023','latest complete Tokyo order list required','custom caller still cannot use processing imports');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000002') FROM fixture$$,'22023','active Tokyo sync lease required','wrong run cannot publish processing snapshot');
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot || '{"store":"manman"}'::jsonb,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'22023','Tokyo store required','other store cannot use Tokyo publication');
UPDATE public.kaitori_checker_sync_run SET completed_at=now()-interval '25 hours'
WHERE id='92000000-0000-4000-8000-000000000001';
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'22023','latest applied checker run required','completed checker older than 24 hours still rejected');
UPDATE public.kaitori_checker_sync_run SET completed_at=now(),status='failed'
WHERE id='92000000-0000-4000-8000-000000000001';
SELECT throws_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'22023','latest applied checker run required','no applied checker still rejected');
UPDATE public.kaitori_checker_sync_run SET status='applied'
WHERE id='92000000-0000-4000-8000-000000000001';
SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products,'94000000-0000-4000-8000-000000000001') FROM fixture$$,'claimed normal sync can publish latest applied checker despite newer running row');
SELECT is((SELECT tokyo_snapshot_id::text FROM run WHERE id='94000000-0000-4000-8000-000000000001'),'93000000-0000-4000-8000-000000000001','run snapshot reference publishes atomically');
SELECT lives_ok($$INSERT INTO public.prepared_card(run_id,source_shinsoku_id,franchise,card_name,grade,list_no,tag,price_high,price_low,source,price_source)
VALUES('94000000-0000-4000-8000-000000000001','s1','Pokemon','カイ','PSA10','236/172','PSA10',9300,9300,'shinsoku','shinsoku')$$,'snapshot product enters normal prepared catalog');
SELECT throws_ok($$UPDATE public.prepared_card SET price_high=8649 WHERE run_id='94000000-0000-4000-8000-000000000001'$$,'22023','prepared product must match its Tokyo snapshot','double discount rejected at database boundary');
SELECT lives_ok($$SELECT finalize_order_list_sync('91000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',1,0,now())$$,'existing finalize completes the normal pipeline');
SELECT is((SELECT row(status,total_prepared,plan_done_at IS NOT NULL)::text FROM run WHERE id='94000000-0000-4000-8000-000000000001'),row('completed'::text,1,true)::text,'normal generate receives completed run with planned timestamp');
UPDATE public.tokyo_buyback_snapshot SET settings='{"box_discount_rates":{"Pokemon":{"no_shrink":0.1},"ONE PIECE":{"no_shrink":0.13}}}'
WHERE id='93000000-0000-4000-8000-000000000001';
CREATE TEMP TABLE box_cases(id text, franchise text, source_price numeric, price_high numeric, expected_low numeric);
INSERT INTO box_cases VALUES
('b1','Pokemon',10000,9000,9000), ('b2','Pokemon',12000,11111,10000),
('b3','Pokemon',12000,11112,10000), ('b4','Pokemon',120000,111111,100000),
('b5','Pokemon',120000,111112,100000), ('b6','Pokemon',1200000,1111111,1000000),
('b7','Pokemon',1200000,1111112,1000000), ('b8','ONE PIECE',100000,93000,87000),
('b9','ONE PIECE',8400,7000,7000), ('b10','ONE PIECE',7000,6000,6000);
INSERT INTO public.tokyo_buyback_product(snapshot_id,id,franchise,product_type,name,source_price,price_high,origins)
SELECT '93000000-0000-4000-8000-000000000001',id,franchise,'box',id,source_price,price_high,'["shinsoku"]' FROM box_cases;
SELECT lives_ok(format($test$INSERT INTO public.prepared_card(run_id,source_shinsoku_id,franchise,card_name,grade,tag,price_high,price_low,source,price_source)
VALUES('94000000-0000-4000-8000-000000000001',%L,%L,%L,'未開封BOX','BOX',%s,%s,'shinsoku','shinsoku')$test$,
id,franchise,id,price_high,expected_low), 'BOX source-price no-shrink tier: ' || id) FROM box_cases ORDER BY id;
SELECT throws_ok($$UPDATE public.prepared_card SET price_low=price_high WHERE source_shinsoku_id='b8'$$,'22023','prepared product must match its Tokyo snapshot','BOX lower cannot copy upper');
SELECT throws_ok($$UPDATE public.prepared_card SET price_low=80000 WHERE source_shinsoku_id='b8'$$,'22023','prepared product must match its Tokyo snapshot','BOX lower must use original source price');
SELECT throws_ok($$UPDATE public.prepared_card SET price_low=9000 WHERE source_shinsoku_id='s1'$$,'22023','prepared product must match its Tokyo snapshot','PSA lower still equals upper');
SELECT throws_ok($$UPDATE public.prepared_card SET price_low=7300 WHERE source_shinsoku_id='b9'$$,'22023','prepared product must match its Tokyo snapshot','lower price cannot exceed upper');
SELECT throws_ok($$UPDATE public.prepared_card SET price_low=5200 WHERE source_shinsoku_id='b10'$$,'22023','prepared product must match its Tokyo snapshot','7000 source must receive the no-shrink discount');
SELECT * FROM finish();
ROLLBACK;
