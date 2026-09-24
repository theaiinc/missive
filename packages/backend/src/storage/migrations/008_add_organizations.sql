-- Add organizations support — each missive can belong to multiple organizations
ALTER TABLE missives ADD COLUMN IF NOT EXISTS organizations TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_missives_organizations ON missives USING gin(organizations);
