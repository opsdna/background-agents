CREATE TABLE IF NOT EXISTS preview_feedback_channels (
  channel_key                    TEXT    PRIMARY KEY,
  linear_organization_id         TEXT    NOT NULL,
  repository                     TEXT    NOT NULL,
  deployment_kind                TEXT    NOT NULL,
  preview_id                     TEXT    NOT NULL,
  pr_number                      INTEGER,
  base_branch                    TEXT    NOT NULL,
  base_sha                       TEXT,
  session_synced_sha             TEXT,
  portal_url                     TEXT    NOT NULL,
  parent_linear_issue_id         TEXT,
  parent_linear_issue_identifier TEXT,
  open_inspect_session_id        TEXT,
  linear_agent_session_id        TEXT,
  status                         TEXT    NOT NULL,
  lease_owner                    TEXT,
  lease_expires_at               INTEGER,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  expires_at                     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_feedback_channels_parent_issue
  ON preview_feedback_channels (parent_linear_issue_id)
  WHERE parent_linear_issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_preview_feedback_channels_expiry
  ON preview_feedback_channels (expires_at, status);
