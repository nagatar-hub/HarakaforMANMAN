\set ON_ERROR_STOP on
BEGIN;
SELECT plan(12);

INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete)
VALUES('c1000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'applied','shop-provenance.xlsx',1,repeat('c',64),'test',true,true);
INSERT INTO public.tokyo_buyback_snapshot(id,store,order_list_import_id,checker_run_id,checker_source_store,fetched_at,business_date,settings,report)
VALUES('c3000000-0000-4000-8000-000000000001','manman-akihabara','c1000000-0000-4000-8000-000000000001',NULL,'manman-akihabara',now(),(now() AT TIME ZONE 'Asia/Tokyo')::date,'{}','{}'),
  ('c3000000-0000-4000-8000-000000000002','manman-akihabara','c1000000-0000-4000-8000-000000000001',NULL,'manman-akihabara',now()+interval '1 second',(now() AT TIME ZONE 'Asia/Tokyo')::date,'{}','{}');

CREATE TEMP TABLE branch_cases(id TEXT, source TEXT, origin JSONB, expected TEXT);
INSERT INTO branch_cases VALUES
('named','blue_rocket','{"source":"blue_rocket","shopId":51,"shopName":"  Blue Rocket 郵送・テスト  "}','Blue Rocket 郵送・テスト'),
('shop-11','blue_rocket','{"source":"blue_rocket","shopId":11}','Blue Rocket（ブルロケ）秋葉原店'),
('shop-44','blue_rocket','{"source":"blue_rocket","shopId":44,"shopName":5}','Blue Rocket（ブルロケ）郵送買取'),
('shop-51','blue_rocket','{"source":"blue_rocket","shopId":51}','Blue Rocket（ブルロケ）秋葉原LAOX店'),
('shop-54','blue_rocket','{"source":"blue_rocket","shopId":54}','Blue Rocket（ブルロケ）大阪なんば日本橋店'),
('shop-55','blue_rocket','{"source":"blue_rocket","shopId":55,"shopName":" "}','Blue Rocket（ブルロケ）福岡買取専門店'),
('old-laox','blue_rocket','{"source":"blue_rocket","id":"api:laox:123"}','Blue Rocket（ブルロケ）秋葉原LAOX店'),
('old-akihabara','blue_rocket','{"source":"blue_rocket","id":"api:akihabara:456"}','Blue Rocket（ブルロケ）秋葉原店'),
('unknown-shop','blue_rocket','{"source":"blue_rocket","shopId":999,"id":"api:laox:123"}','Blue Rocket'),
('invalid-old-id','blue_rocket','{"source":"blue_rocket","id":"api:laox:0"}','Blue Rocket'),
('no-branch','blue_rocket','{"source":"blue_rocket"}','Blue Rocket'),
('other-source','extoreca','{"source":"extoreca","shopName":"ignored branch"}','エクストレカ');

INSERT INTO public.tokyo_buyback_product(snapshot_id,id,franchise,product_type,name,source_price,price_high,price_low,selected_high_source,selected_low_source,origins)
SELECT 'c3000000-0000-4000-8000-000000000001',id,'Pokemon','psa',id,140000,130000,130000,source,source,jsonb_build_array(origin)
FROM branch_cases;
INSERT INTO public.tokyo_buyback_product(snapshot_id,id,franchise,product_type,name,source_price,price_high,price_low,selected_high_source,selected_low_source,origins)
SELECT 'c3000000-0000-4000-8000-000000000002',id,'Pokemon','psa',id,145000,135000,135000,source,source,
  jsonb_build_array(origin || jsonb_build_object('shopName','Blue Rocket 更新後 ' || id))
FROM branch_cases;
INSERT INTO public.custom_buyback_sheet(id,store,name,franchise,product_type,kind,catalog_source,tokyo_snapshot_id,price_business_date,display_date)
VALUES('c4000000-0000-4000-8000-000000000001','manman-akihabara','Tokyo branch details','Pokemon','psa','store','shinsoku',
  'c3000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'Asia/Tokyo')::date,(now() AT TIME ZONE 'Asia/Tokyo')::date);

SELECT lives_ok($$SELECT add_custom_buyback_shinsoku_items('c4000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY(SELECT id FROM branch_cases ORDER BY id))$$,
  'custom sheet accepts products with current and historical branch provenance');
SELECT is((SELECT array_agg(source_shop_name ORDER BY source_shinsoku_id)::text FROM public.custom_buyback_item WHERE sheet_id='c4000000-0000-4000-8000-000000000001'),
  (SELECT array_agg(expected ORDER BY id)::text FROM branch_cases),'add uses the same branch label precedence and fallback as sheet details');
SELECT ok((SELECT bool_and(source_price_high=130000 AND final_price_high=130000) FROM public.custom_buyback_item WHERE sheet_id='c4000000-0000-4000-8000-000000000001'),
  'branch labels do not change the adopted prices');

UPDATE public.custom_buyback_item SET final_price_high=125000,override_reason='manual override'
WHERE sheet_id='c4000000-0000-4000-8000-000000000001' AND source_shinsoku_id='named';
SELECT lives_ok($$SELECT refresh_custom_buyback_shinsoku_prices('c4000000-0000-4000-8000-000000000001','manman-akihabara','c3000000-0000-4000-8000-000000000002',true)$$,
  'refresh adopts branch provenance from the new snapshot');
SELECT is((SELECT array_agg(source_shop_name ORDER BY source_shinsoku_id)::text FROM public.custom_buyback_item WHERE sheet_id='c4000000-0000-4000-8000-000000000001'),
  (SELECT array_agg(CASE source WHEN 'blue_rocket' THEN 'Blue Rocket 更新後 ' || id ELSE expected END ORDER BY id)::text FROM branch_cases),
  'refresh updates actual branch names and keeps other-source labels');
SELECT is((SELECT row(final_price_high,source_price_high,override_reason)::text FROM public.custom_buyback_item WHERE sheet_id='c4000000-0000-4000-8000-000000000001' AND source_shinsoku_id='named'),
  row(125000::numeric,135000::numeric,'manual override'::text)::text,'branch refresh preserves manual overrides');
SELECT ok((SELECT bool_and(final_price_high=135000) FROM public.custom_buyback_item WHERE sheet_id='c4000000-0000-4000-8000-000000000001' AND source_shinsoku_id<>'named'),
  'non-overridden prices still update from the new snapshot');
SELECT throws_ok($$SELECT add_custom_buyback_shinsoku_items('c4000000-0000-4000-8000-000000000001','manman',ARRAY['named'])$$,
  'P0002','sheet not found','other stores cannot add items to the Tokyo sheet');

UPDATE public.custom_buyback_sheet SET status='rendering' WHERE id='c4000000-0000-4000-8000-000000000001';
SELECT throws_ok($$SELECT add_custom_buyback_shinsoku_items('c4000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY['named'])$$,
  '22023','invalid Tokyo sheet','rendering still prevents item additions');
SELECT throws_ok($$SELECT refresh_custom_buyback_shinsoku_prices('c4000000-0000-4000-8000-000000000001','manman-akihabara','c3000000-0000-4000-8000-000000000002',true)$$,
  '22023','invalid Tokyo sheet','rendering still prevents price refresh');
SELECT ok(has_function_privilege('service_role','public.add_custom_buyback_shinsoku_items(uuid,text,text[])','EXECUTE')
  AND has_function_privilege('service_role','public.refresh_custom_buyback_shinsoku_prices(uuid,text,uuid,boolean)','EXECUTE'),
  'service role retains access to both custom-sheet functions');
SELECT ok(NOT has_function_privilege('anon','public.add_custom_buyback_shinsoku_items(uuid,text,text[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.add_custom_buyback_shinsoku_items(uuid,text,text[])','EXECUTE')
  AND NOT has_function_privilege('anon','public.refresh_custom_buyback_shinsoku_prices(uuid,text,uuid,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.refresh_custom_buyback_shinsoku_prices(uuid,text,uuid,boolean)','EXECUTE'),
  'browser callers still cannot execute custom-sheet writes directly');
SELECT * FROM finish();
ROLLBACK;
