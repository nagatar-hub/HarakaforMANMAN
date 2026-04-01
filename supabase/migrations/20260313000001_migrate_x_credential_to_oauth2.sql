-- OAuth 2.0 PKCE への移行: x_credential テーブル変更
-- Secret Manager参照カラムを削除し、トークン直接保存に変更

-- 旧カラム削除
ALTER TABLE x_credential
  DROP COLUMN IF EXISTS secret_name_api_key,
  DROP COLUMN IF EXISTS secret_name_api_secret,
  DROP COLUMN IF EXISTS secret_name_access_token,
  DROP COLUMN IF EXISTS secret_name_access_secret;

-- 新カラム追加
ALTER TABLE x_credential
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

-- 既存データ削除（旧方式のデータは使えない）
DELETE FROM x_credential;
