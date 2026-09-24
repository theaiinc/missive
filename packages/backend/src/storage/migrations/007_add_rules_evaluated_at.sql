-- ── Track when rules were last evaluated per missive ──
-- Allows periodic re-evaluation of missives that have changed
-- (e.g. got a classification) since their last rule evaluation.
ALTER TABLE missives ADD COLUMN IF NOT EXISTS rules_evaluated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_missives_rules_pending
  ON missives(rules_evaluated_at NULLS FIRST)
  WHERE rules_evaluated_at IS NULL OR rules_evaluated_at < updated_at;
