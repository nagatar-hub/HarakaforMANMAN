-- Shared by Oripark, MANMAN and MANMAN Tokyo. Apply once to their shared DB.
-- Additive: legacy plans and credentials are retained; no external posts are sent here.
ALTER TABLE public.x_credential
  ADD COLUMN IF NOT EXISTS posting_kind text CHECK (posting_kind IN ('store','postal')),
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS x_credential_store_x_user_unique ON public.x_credential(store,x_user_id) WHERE x_user_id IS NOT NULL;
ALTER TABLE public.post_plan
  ADD COLUMN IF NOT EXISTS posting_data jsonb,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by text;

CREATE TABLE IF NOT EXISTS public.x_oauth_request (
  state uuid PRIMARY KEY,
  store text NOT NULL,
  verifier_ciphertext text NOT NULL,
  operator_email text NOT NULL,
  posting_kind text NOT NULL CHECK (posting_kind IN ('store','postal')),
  expected_user_id text,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.x_oauth_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x_oauth_request FROM anon, authenticated;
GRANT ALL ON public.x_oauth_request TO service_role;
-- Tokens, unpublished copy and account administration are server-only.
ALTER TABLE public.x_credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x_credential FROM anon, authenticated;
GRANT ALL ON public.x_credential TO service_role;
ALTER TABLE public.post_plan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.post_plan FROM anon, authenticated;
GRANT ALL ON public.post_plan TO service_role;

CREATE OR REPLACE FUNCTION public.x_account_lease(p_store text, p_id uuid, p_token uuid, p_release boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_release THEN
    UPDATE public.x_credential SET lease_token=NULL, lease_expires_at=NULL
      WHERE store=p_store AND id=p_id AND lease_token=p_token;
  ELSE
    UPDATE public.x_credential SET lease_token=p_token, lease_expires_at=clock_timestamp()+interval '5 minutes'
      WHERE store=p_store AND id=p_id
        AND (lease_token=p_token OR lease_expires_at IS NULL OR lease_expires_at<clock_timestamp());
  END IF;
  RETURN FOUND;
END;
$$;

-- Every edit/claim/result is serialized on the plan row. Revision checks reject
-- stale browser tabs. A claim also leases the account to serialize token refresh.
CREATE OR REPLACE FUNCTION public.x_post_transition(
  p_store text, p_id uuid, p_revision integer, p_action text, p_payload jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  p public.post_plan%ROWTYPE;
  a public.x_credential%ROWTYPE;
  d jsonb;
  item jsonb;
  item_index integer;
  idx integer;
  token uuid;
  outcome text;
BEGIN
  SELECT * INTO p FROM public.post_plan WHERE store=p_store AND id=p_id FOR UPDATE;
  IF NOT FOUND OR p.posting_data IS NULL THEN RAISE EXCEPTION '投稿が見つかりません' USING ERRCODE='P0002'; END IF;
  IF p.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION '内容が更新されています。再読み込みしてください' USING ERRCODE='40001'; END IF;
  d := p.posting_data;
  SELECT ord::integer-1 INTO item_index FROM jsonb_array_elements(d->'items') WITH ORDINALITY e(v,ord)
    WHERE v->>'status'<>'posted' ORDER BY ord LIMIT 1;

  IF p_action='recover' THEN
    IF p.lease_token IS NULL OR p.lease_expires_at>clock_timestamp() THEN
      RAISE EXCEPTION '処理が終了するまでお待ちください' USING ERRCODE='55P03';
    END IF;
    IF item_index IS NOT NULL THEN
      item:=d->'items'->item_index;
      outcome:=CASE WHEN item->>'status'='posting' THEN 'unknown' ELSE 'failed' END;
      d:=jsonb_set(d,ARRAY['items',item_index::text],item||jsonb_build_object('status',outcome,'error',
        CASE WHEN outcome='unknown' THEN '送信結果を確認できません。X上の投稿を確認してください' ELSE '送信前に中断しました。再開できます' END));
    END IF;
    PERFORM public.x_account_lease(p_store,p.x_credential_id,p.lease_token,true);
    p.lease_token:=NULL; p.lease_expires_at:=NULL; p.status:='partial';
  ELSIF p_action IN ('sending','finish') THEN
    IF p.lease_token IS NULL OR p.lease_token::text IS DISTINCT FROM p_payload->>'token'
      OR p.lease_expires_at<clock_timestamp() OR item_index IS NULL THEN
      RAISE EXCEPTION '投稿の実行権限が失効しました。結果を確認してください' USING ERRCODE='40001';
    END IF;
    item:=d->'items'->item_index;
    IF p_action='sending' THEN
      IF item->>'status'<>'preparing' THEN RAISE EXCEPTION '送信済みの処理です' USING ERRCODE='40001'; END IF;
      d:=jsonb_set(d,ARRAY['items',item_index::text,'status'],'"posting"');
    ELSE
      outcome:=p_payload->>'status';
      IF outcome NOT IN ('posted','failed','unknown') OR outcome IS NULL THEN RAISE EXCEPTION 'Invalid result'; END IF;
      IF outcome='posted' AND (item->>'status'<>'posting' OR coalesce(p_payload->>'tweet_id','')!~'^[0-9]+$') THEN
        RAISE EXCEPTION 'Invalid post receipt';
      END IF;
      d:=jsonb_set(d,ARRAY['items',item_index::text], item||jsonb_build_object(
        'status',outcome,'tweet_id',p_payload->>'tweet_id','error',p_payload->>'error'));
      IF outcome='posted' AND item_index=0 THEN p.thread_head_tweet_id:=p_payload->>'tweet_id'; END IF;
      p.status:=CASE WHEN outcome='posted' THEN 'posting' ELSE 'partial' END;
      PERFORM public.x_account_lease(p_store,p.x_credential_id,p.lease_token,true);
      p.lease_token:=NULL; p.lease_expires_at:=NULL;
    END IF;
  ELSE
    IF p.lease_token IS NOT NULL THEN RAISE EXCEPTION '投稿処理中です。時間をおいて結果を確認してください' USING ERRCODE='55P03'; END IF;
    IF p_action='edit' THEN
      IF item_index IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'items') e WHERE e->>'status'='unknown') THEN
        RAISE EXCEPTION 'この状態では編集できません' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(p_payload->'texts') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_payload->'texts')<>jsonb_array_length(d->'items') THEN RAISE EXCEPTION 'Invalid items'; END IF;
      FOR idx IN 0..jsonb_array_length(d->'items')-1 LOOP
        IF jsonb_typeof(p_payload->'texts'->idx)<>'string' THEN RAISE EXCEPTION 'Invalid text'; END IF;
        IF d->'items'->idx->>'status'='posted' AND d->'items'->idx->>'text' IS DISTINCT FROM p_payload->'texts'->>idx THEN
          RAISE EXCEPTION '投稿済みの本文は変更できません' USING ERRCODE='40001';
        END IF;
        d:=jsonb_set(d,ARRAY['items',idx::text,'text'],p_payload->'texts'->idx);
      END LOOP;
    ELSIF p_action='claim' THEN
      IF item_index IS NULL THEN RAISE EXCEPTION '投稿は完了しています' USING ERRCODE='40001'; END IF;
      item:=d->'items'->item_index;
      IF item->>'status' NOT IN ('pending','failed') THEN RAISE EXCEPTION '送信結果を確認してから再開してください' USING ERRCODE='40001'; END IF;
      IF p_payload->>'account_user_id' IS DISTINCT FROM d->'account'->>'user_id' THEN RAISE EXCEPTION '投稿先を確認してください'; END IF;
      SELECT * INTO a FROM public.x_credential WHERE store=p_store AND id=p.x_credential_id FOR UPDATE;
      IF NOT FOUND OR a.status<>'active' OR a.posting_kind IS DISTINCT FROM d->>'kind'
        OR a.x_user_id IS DISTINCT FROM d->'account'->>'user_id' THEN
        RAISE EXCEPTION '投稿先アカウントの認証・用途を確認してください' USING ERRCODE='40001';
      END IF;
      token:=gen_random_uuid();
      IF NOT public.x_account_lease(p_store,a.id,token) THEN RAISE EXCEPTION 'このアカウントは処理中です' USING ERRCODE='55P03'; END IF;
      p.lease_token:=token; p.lease_expires_at:=clock_timestamp()+interval '5 minutes'; p.status:='posting';
      d:=jsonb_set(d,ARRAY['items',item_index::text], item||jsonb_build_object('status','preparing','error',NULL));
    ELSIF p_action='resolve' THEN
      IF item_index IS NULL OR d->'items'->item_index->>'status'<>'unknown' THEN RAISE EXCEPTION '確認待ちの投稿がありません'; END IF;
      outcome:=p_payload->>'status';
      IF outcome NOT IN ('posted','failed') OR outcome IS NULL THEN RAISE EXCEPTION 'Invalid resolution'; END IF;
      IF outcome='posted' AND coalesce(p_payload->>'tweet_id','')!~'^[0-9]+$' THEN RAISE EXCEPTION '投稿URLが必要です'; END IF;
      d:=jsonb_set(d,ARRAY['items',item_index::text],(d->'items'->item_index)||jsonb_build_object(
        'status',outcome,'tweet_id',p_payload->>'tweet_id','error',NULL));
      IF outcome='posted' AND item_index=0 THEN p.thread_head_tweet_id:=p_payload->>'tweet_id'; END IF;
      p.status:='partial';
    ELSE RAISE EXCEPTION 'Invalid action';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'items') e WHERE e->>'status'<>'posted') THEN p.status:='completed'; END IF;
  UPDATE public.post_plan SET posting_data=d, revision=revision+1, status=p.status,
    lease_token=p.lease_token, lease_expires_at=p.lease_expires_at,
    thread_head_tweet_id=p.thread_head_tweet_id, updated_at=clock_timestamp()
    WHERE id=p.id RETURNING * INTO p;
  RETURN to_jsonb(p);
END;
$$;
REVOKE ALL ON FUNCTION public.x_account_lease(text,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.x_post_transition(text,uuid,integer,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.x_account_lease(text,uuid,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.x_post_transition(text,uuid,integer,text,jsonb) TO service_role;
