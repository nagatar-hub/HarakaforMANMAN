\set ON_ERROR_STOP on
BEGIN;
SELECT plan(13);

SELECT lives_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,tcgmp_product_id,tcgmp_sku,image_url,sha256,verified_at,evidence)
  VALUES ('box-haraka','Pokemon','box','Golden Box',NULL,'haraka','11111111-1111-1111-1111-111111111111',NULL,NULL,
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/haraka/'||repeat('a',64)||'.png',repeat('a',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  'Haraka BOX with null model is allowed');
SELECT lives_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,tcgmp_product_id,tcgmp_sku,image_url,sha256,verified_at,evidence)
  VALUES ('box-cardrush','ONE PIECE','box','OP BOX',NULL,'cardrush','123',NULL,NULL,
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/cardrush/'||repeat('b',64)||'.png',repeat('b',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  'Cardrush BOX with null model is allowed');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('box-onphalos','Pokemon','box','bad',NULL,'onphalos','123','https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('c',64)||'.png',repeat('c',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  '23514', NULL, 'ONPHALOS BOX is rejected');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,tcgmp_product_id,tcgmp_sku,image_url,sha256,verified_at,evidence)
  VALUES ('box-tcgmp','Pokemon','box','bad',NULL,'tcgmp','123','123','sku','https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/tcgmp/'||repeat('d',64)||'.png',repeat('d',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  '23514', NULL, 'TCGMP BOX is rejected');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('box-numbered','Pokemon','box','bad','001','haraka','22222222-2222-2222-2222-222222222222','https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/haraka/'||repeat('e',64)||'.png',repeat('e',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  '23514', NULL, 'BOX with a model number is rejected');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('op-onphalos','ONE PIECE','psa','bad','OP01-001','onphalos','123','https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('f',64)||'.png',repeat('f',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  '23514', NULL, 'ONPHALOS remains Pokemon PSA only');
SELECT lives_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('pokemon-onphalos','Pokemon','psa','card','001/001','onphalos','123',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('0',64)||'.jpg',repeat('0',64),now(),'{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  'ONPHALOS Pokemon PSA remains allowed');
SELECT lives_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('pokemon-onphalos-null','Pokemon','psa','card',NULL,'onphalos','124',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('1',64)||'.jpg',repeat('1',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"pixel_exact":true,"source_image_sha256":"1111111111111111111111111111111111111111111111111111111111111111","note":"test"}')$$,
  'pixel-exact ONPHALOS Pokemon PSA may omit model');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('pokemon-onphalos-null-weak','Pokemon','psa','card',NULL,'onphalos','125',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('2',64)||'.jpg',repeat('2',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"test"}')$$,
  '23514', NULL, 'null-model ONPHALOS PSA without pixel proof is rejected');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('pokemon-onphalos-null-mismatch','Pokemon','psa','card',NULL,'onphalos','126',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/onphalos/'||repeat('3',64)||'.jpg',repeat('3',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"pixel_exact":true,"source_image_sha256":"4444444444444444444444444444444444444444444444444444444444444444","note":"test"}')$$,
  '23514', NULL, 'null-model ONPHALOS PSA with mismatched source hash is rejected');

SELECT lives_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('cardrush-null-exact','ONE PIECE','psa','DON',NULL,'cardrush','10197',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/cardrush/'||repeat('5',64)||'.jpg',repeat('5',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"source_sha256_equal":true,"source_image_sha256":"5555555555555555555555555555555555555555555555555555555555555555","note":"test"}')$$,
  'exact-source Cardrush PSA may omit model');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('cardrush-null-manual','ONE PIECE','psa','DON',NULL,'cardrush','10198',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/cardrush/'||repeat('6',64)||'.jpg',repeat('6',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"source_image_sha256":"6666666666666666666666666666666666666666666666666666666666666666","note":"test"}')$$,
  '23514', NULL, 'null-model Cardrush PSA without exact-source flag is rejected');
SELECT throws_ok($$INSERT INTO public.tokyo_card_image_mapping
  (source_shinsoku_id,franchise,product_type,name,model_number,provider,provider_product_id,image_url,sha256,verified_at,evidence)
  VALUES ('cardrush-null-mismatch','ONE PIECE','psa','DON',NULL,'cardrush','10199',
  'https://abyecthqjjssegwazhwm.supabase.co/storage/v1/object/public/haraka-images/card-images/manman-akihabara/cardrush/'||repeat('7',64)||'.jpg',repeat('7',64),now(),
  '{"no_sample":true,"no_slab":true,"variant_confirmed":true,"source_sha256_equal":true,"source_image_sha256":"8888888888888888888888888888888888888888888888888888888888888888","note":"test"}')$$,
  '23514', NULL, 'null-model Cardrush PSA with mismatched source hash is rejected');

SELECT * FROM finish();
ROLLBACK;
