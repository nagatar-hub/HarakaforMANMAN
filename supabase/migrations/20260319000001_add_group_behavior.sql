-- rule テーブルに group behavior と group_key を追加
ALTER TABLE rule DROP CONSTRAINT rule_behavior_check;
ALTER TABLE rule ADD CONSTRAINT rule_behavior_check
  CHECK (behavior IN ('isolate', 'merge', 'exclude', 'group'));

ALTER TABLE rule ADD COLUMN group_key TEXT;

CREATE INDEX idx_rule_group_key ON rule(group_key) WHERE group_key IS NOT NULL;
