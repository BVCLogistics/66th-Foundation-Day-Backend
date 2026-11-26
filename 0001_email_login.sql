CREATE TABLE email_login_challenges (
  scope TEXT NOT NULL,
  email TEXT NOT NULL,
  challenge TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  send_count INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, email)
);
--> statement-breakpoint
CREATE TABLE email_login_rate (
  bucket TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE dashboard_reviewers (
  email TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK (role = 'reviewer')
);
--> statement-breakpoint
CREATE TABLE employee_allowlist (
  email TEXT PRIMARY KEY NOT NULL,
  added_at TEXT NOT NULL
);
