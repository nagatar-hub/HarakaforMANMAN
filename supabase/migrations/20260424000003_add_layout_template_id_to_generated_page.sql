-- generated_page.layout_template_id
--
-- 各ページがどの layout_template で生成されたかを記録する。
-- 再生成（regenerate-page）でも同じテンプレートを使うため必須。
-- 既存行が残っている場合は NULL を許容し、コード側でフォールバック。
ALTER TABLE generated_page
  ADD COLUMN layout_template_id UUID REFERENCES layout_template(id);
CREATE INDEX idx_generated_page_layout_template
  ON generated_page(layout_template_id);
