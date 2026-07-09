-- External resources provisioned for a session, such as per-session Neon branches.
CREATE TABLE IF NOT EXISTS session_resources (
  id            TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  resource_type TEXT    NOT NULL,
  resource_id   TEXT    NOT NULL,
  resource_name TEXT    NOT NULL,
  repo_owner    TEXT    NOT NULL,
  repo_name     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active',
  metadata      TEXT,
  delete_after  INTEGER,
  deleted_at    INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_session_resources_session
  ON session_resources (session_id, resource_type);

CREATE INDEX IF NOT EXISTS idx_session_resources_due_delete
  ON session_resources (delete_after, status)
  WHERE deleted_at IS NULL AND delete_after IS NOT NULL;
