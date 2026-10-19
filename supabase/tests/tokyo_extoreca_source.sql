\set ON_ERROR_STOP on
BEGIN;
SELECT plan(6);

INSERT INTO public.order_list_import(id,store,business_date,status,original_filename,original_size_bytes,sha256,storage_path,structural_valid,persistence_complete)
VALUES('a1000000-0000-4000-8000-000000000001','manman-akihabara',current_date,'applied','test.xlsx',1,repeat('a',64),'test',true,true);
INSERT INTO public.kaitori_checker_sync_run(id,store,request_key,trigger,claim_token,status,product_count,offer_count,ranking_count,content_hash,started_at,completed_at)
VALUES('a2000000-0000-4000-8000-000000000001','oripark','tokyo-extoreca-test','manual','test','applied',1,1,1,repeat('b',64),now(),now());
CREATE TEMP TABLE fixture AS SELECT jsonb_build_object(
  'id','a3000000-0000-4000-8000-000000000001','store','manman-akihabara',
  'order_list_import_id','a1000000-0000-4000-8000-000000000001','checker_run_id','a2000000-0000-4000-8000-000000000001',
  'checker_source_store','oripark','fetched_at',clock_timestamp(),'business_date',(now() AT TIME ZONE 'Asia/Tokyo')::date,
  'settings','{}'::jsonb,'report','{"pricing_version":"2"}'::jsonb) AS snapshot,
  '[{"id":"extoreca-1","franchise":"Pokemon","product_type":"psa","name":"カイ","model_number":"236/172","source_price":54000,"price_high":48000,"price_low":48000,"selected_high_source":"extoreca","selected_low_source":"extoreca","origins":[{"source":"extoreca","rawPrice":54000}]}]'::jsonb AS products;

SELECT lives_ok($$SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture$$,'Extoreca source publishes through the existing snapshot function');
SELECT is((SELECT row(selected_high_source,selected_low_source)::text FROM public.tokyo_buyback_product WHERE id='extoreca-1'),
  row('extoreca'::text,'extoreca'::text)::text,'both selected-source constraints allow Extoreca');
SELECT throws_ok($$UPDATE public.tokyo_buyback_product SET selected_high_source='unknown' WHERE id='extoreca-1'$$,
  '23514',NULL,'unknown source remains rejected');

INSERT INTO public.custom_buyback_sheet(id,store,name,franchise,product_type,kind,catalog_source,tokyo_snapshot_id,price_business_date,display_date)
VALUES('a4000000-0000-4000-8000-000000000001','manman-akihabara','Tokyo','Pokemon','psa','store','shinsoku',
  'a3000000-0000-4000-8000-000000000001',current_date,current_date);
SELECT lives_ok($$SELECT add_custom_buyback_shinsoku_items('a4000000-0000-4000-8000-000000000001','manman-akihabara',ARRAY['extoreca-1'])$$,
  'Extoreca-priced product can be added to the Tokyo sheet');
SELECT is((SELECT source_shop_name FROM public.custom_buyback_item WHERE sheet_id='a4000000-0000-4000-8000-000000000001'),
  'エクストレカ','add function persists the Extoreca label');

UPDATE fixture SET snapshot=snapshot || jsonb_build_object('id','a3000000-0000-4000-8000-000000000002','fetched_at',clock_timestamp()+interval '1 second'),
  products=jsonb_set(jsonb_set(products,'{0,price_high}','49000'),'{0,price_low}','49000');
SELECT publish_tokyo_buyback_snapshot(snapshot,products) FROM fixture;
SELECT refresh_custom_buyback_shinsoku_prices('a4000000-0000-4000-8000-000000000001','manman-akihabara',
  'a3000000-0000-4000-8000-000000000002',false);
SELECT is((SELECT row(source_shop_name,source_price_high)::text FROM public.custom_buyback_item WHERE sheet_id='a4000000-0000-4000-8000-000000000001'),
  row('エクストレカ'::text,49000::numeric)::text,'refresh function keeps the Extoreca label and adopted price');

SELECT * FROM finish();
ROLLBACK;
