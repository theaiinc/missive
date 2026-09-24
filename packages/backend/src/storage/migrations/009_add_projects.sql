-- Add projects support — each missive can belong to multiple projects
ALTER TABLE missives ADD COLUMN IF NOT EXISTS projects TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_missives_projects ON missives USING gin(projects);
