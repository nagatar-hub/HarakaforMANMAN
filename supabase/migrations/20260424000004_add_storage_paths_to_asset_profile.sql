-- asset_profile に Supabase Storage 参照カラムを追加
--
-- 既存の template_image / card_back_image は Google Drive ID を保持していたが、
-- Drive 非依存化のため Supabase Storage のパスに段階的に移行する。
-- Phase 4 以降は *_storage_path が優先、NULL のときのみ Drive ID をフォールバック。
-- BOX 用のテンプレ／カード裏面は現状 layout_config JSONB に埋め込まれているが、
-- こちらも Storage パスを独立カラムに昇格させる。
ALTER TABLE asset_profile ADD COLUMN template_storage_path        TEXT;
ALTER TABLE asset_profile ADD COLUMN card_back_storage_path       TEXT;
ALTER TABLE asset_profile ADD COLUMN template_box_storage_path    TEXT;
ALTER TABLE asset_profile ADD COLUMN card_back_box_storage_path   TEXT;
