CREATE TABLE submissions (
  id TEXT PRIMARY KEY NOT NULL,
  activity TEXT NOT NULL CHECK(activity IN ('drawing', 'collage', 'campaign', 'journal')),
  employee TEXT NOT NULL,
  employee_code TEXT NOT NULL,
  employee_email TEXT NOT NULL,
  branch TEXT NOT NULL,
  child_name TEXT,
  campaign_title TEXT,
  journal TEXT,
  received_at TEXT NOT NULL,
  attachments TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX submissions_activity_idx ON submissions(activity);
