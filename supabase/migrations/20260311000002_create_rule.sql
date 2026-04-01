CREATE TABLE rule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise     TEXT NOT NULL
                CHECK (franchise IN ('Pokemon', 'ONE PIECE', 'YU-GI-OH!')),
  tag_pattern   TEXT NOT NULL,
  match_type    TEXT NOT NULL DEFAULT 'exact'
                CHECK (match_type IN ('exact', 'contains', 'regex')),
  behavior      TEXT NOT NULL
                CHECK (behavior IN ('isolate', 'merge', 'exclude')),
  priority      INT NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rule_franchise ON rule(franchise);
CREATE INDEX idx_rule_priority ON rule(priority DESC);
