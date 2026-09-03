CREATE TABLE IF NOT EXISTS public.operator_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  http_method TEXT NOT NULL CHECK (http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  request_path TEXT NOT NULL,
  target_id TEXT,
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_audit_log_store_created_at_idx
  ON public.operator_audit_log (store, created_at DESC);

ALTER TABLE public.operator_audit_log ENABLE ROW LEVEL SECURITY;
