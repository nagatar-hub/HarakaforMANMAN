-- Prevent an older, otherwise valid Excel import from being activated after a
-- newer valid workbook for the same store has already been persisted.
--
-- The API performs the same check to return a friendly 409 before queueing.
-- This trigger is the final database boundary for RPC callers and retries.

CREATE OR REPLACE FUNCTION public.reject_stale_order_list_import_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest public.order_list_import%ROWTYPE;
BEGIN
  IF NEW.status <> 'confirmed'
    OR OLD.status = 'confirmed'
    OR NEW.persistence_complete IS NOT TRUE
    OR NEW.structural_valid IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT candidate.*
  INTO v_latest
  FROM public.order_list_import AS candidate
  WHERE candidate.store = NEW.store
    AND candidate.id <> NEW.id
    AND candidate.persistence_complete IS TRUE
    AND candidate.structural_valid IS TRUE
    AND (
      candidate.business_date > NEW.business_date
      OR (
        candidate.business_date = NEW.business_date
        AND candidate.created_at > NEW.created_at
      )
    )
  ORDER BY candidate.business_date DESC, candidate.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'より新しいオーダーリスト取込があるため、過去取込を同期できません: latest_file=%, latest_business_date=%, latest_import_id=%',
      v_latest.original_filename,
      v_latest.business_date,
      v_latest.id
      USING ERRCODE = '55000',
            HINT = '最新の有効なオーダーリスト取込を選択してください';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_reject_stale_order_list_import_activation
  ON public.order_list_import;

CREATE TRIGGER trg_reject_stale_order_list_import_activation
BEFORE UPDATE OF status ON public.order_list_import
FOR EACH ROW
WHEN (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.reject_stale_order_list_import_activation();

REVOKE ALL ON FUNCTION public.reject_stale_order_list_import_activation()
  FROM PUBLIC, anon, authenticated;
