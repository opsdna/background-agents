export type SessionResourceType = "neon_branch";
export type SessionResourceLifecycleOwner = "open_inspect_session" | "github_pr";
export type SessionResourceStatus =
  | "active"
  | "pending_delete"
  | "deleting"
  | "delete_failed"
  | "deleted";

export interface SessionResourceRow {
  id: string;
  session_id: string;
  resource_type: SessionResourceType;
  resource_id: string;
  resource_name: string;
  repo_owner: string;
  repo_name: string;
  status: SessionResourceStatus;
  metadata: string | null;
  delete_after: number | null;
  deleted_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertNeonBranchResource {
  sessionId: string;
  repoOwner: string;
  repoName: string;
  branchId: string;
  branchName: string;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface NeonBranchPullRequestOwnership {
  sessionId: string;
  gitBranch: string;
  prNumber: number;
  prUrl: string;
  repoOwner: string;
  repoName: string;
  now?: number;
}

export class SessionResourceStore {
  constructor(private readonly db: D1Database) {}

  async upsertNeonBranch(input: UpsertNeonBranchResource): Promise<void> {
    const now = input.now ?? Date.now();
    const id = resourcePrimaryKey(input.sessionId, "neon_branch", input.branchId);
    const metadata = JSON.stringify({
      ...input.metadata,
      lifecycleOwner: "open_inspect_session" satisfies SessionResourceLifecycleOwner,
    });

    await this.db
      .prepare(
        `INSERT INTO session_resources
         (id, session_id, resource_type, resource_id, resource_name, repo_owner, repo_name,
          status, metadata, delete_after, deleted_at, last_error, created_at, updated_at)
         VALUES (?, ?, 'neon_branch', ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(resource_type, resource_id) DO UPDATE SET
           session_id = excluded.session_id,
           resource_name = excluded.resource_name,
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           status = 'active',
           metadata = CASE
             WHEN json_extract(COALESCE(session_resources.metadata, '{}'), '$.lifecycleOwner') = 'github_pr'
             THEN json_set(
               COALESCE(session_resources.metadata, '{}'),
               '$.projectId', json_extract(excluded.metadata, '$.projectId'),
               '$.gitBranch', json_extract(excluded.metadata, '$.gitBranch')
             )
             ELSE excluded.metadata
           END,
           delete_after = NULL,
           deleted_at = NULL,
           last_error = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        input.sessionId,
        input.branchId,
        input.branchName,
        input.repoOwner.toLowerCase(),
        input.repoName.toLowerCase(),
        metadata,
        now,
        now
      )
      .run();
  }

  /**
   * Transfer deletion ownership to the GitHub PR workflow after PR creation.
   * The git branch is part of the predicate so legacy resources from an older
   * naming scheme cannot accidentally be claimed by a new PR.
   */
  async markNeonBranchOwnedByPullRequest(input: NeonBranchPullRequestOwnership): Promise<number> {
    const now = input.now ?? Date.now();
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'active',
             delete_after = NULL,
             deleted_at = NULL,
             last_error = NULL,
             metadata = json_set(
               COALESCE(metadata, '{}'),
               '$.lifecycleOwner', 'github_pr',
               '$.gitBranch', ?,
               '$.prNumber', ?,
               '$.prUrl', ?,
               '$.prRepoOwner', ?,
               '$.prRepoName', ?
             ),
             updated_at = ?
         WHERE session_id = ?
           AND resource_type = 'neon_branch'
           AND deleted_at IS NULL
           AND json_extract(COALESCE(metadata, '{}'), '$.gitBranch') = ?`
      )
      .bind(
        input.gitBranch,
        input.prNumber,
        input.prUrl,
        input.repoOwner.toLowerCase(),
        input.repoName.toLowerCase(),
        now,
        input.sessionId,
        input.gitBranch
      )
      .run();

    return result.meta?.changes ?? 0;
  }

  async markSessionForDeletion(
    sessionId: string,
    deleteAfter: number,
    reason: string,
    now = Date.now()
  ): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'pending_delete',
             delete_after = ?,
             last_error = NULL,
             updated_at = ?,
             metadata = json_set(COALESCE(metadata, '{}'), '$.deleteReason', ?)
         WHERE session_id = ?
           AND deleted_at IS NULL
           AND status != 'deleted'
           AND COALESCE(json_extract(metadata, '$.lifecycleOwner'), 'open_inspect_session') != 'github_pr'`
      )
      .bind(deleteAfter, now, reason, sessionId)
      .run();

    return result.meta?.changes ?? 0;
  }

  async clearPendingDeletion(sessionId: string, now = Date.now()): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'active',
             delete_after = NULL,
             last_error = NULL,
             updated_at = ?
         WHERE session_id = ?
           AND deleted_at IS NULL
           AND status IN ('pending_delete', 'delete_failed')`
      )
      .bind(now, sessionId)
      .run();

    return result.meta?.changes ?? 0;
  }

  async listDueForDeletion(now = Date.now(), limit = 25): Promise<SessionResourceRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM session_resources
         WHERE deleted_at IS NULL
           AND delete_after IS NOT NULL
           AND delete_after <= ?
           AND status IN ('pending_delete', 'deleting', 'delete_failed')
           AND COALESCE(json_extract(metadata, '$.lifecycleOwner'), 'open_inspect_session') != 'github_pr'
         ORDER BY delete_after ASC, updated_at ASC
         LIMIT ?`
      )
      .bind(now, limit)
      .all<SessionResourceRow>();

    return result.results ?? [];
  }

  async markDeleting(id: string, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'deleting', updated_at = ?
         WHERE id = ?
           AND deleted_at IS NULL
           AND COALESCE(json_extract(metadata, '$.lifecycleOwner'), 'open_inspect_session') != 'github_pr'`
      )
      .bind(now, id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async markDeleted(id: string, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'deleted',
             deleted_at = ?,
             delete_after = NULL,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?
           AND deleted_at IS NULL
           AND COALESCE(json_extract(metadata, '$.lifecycleOwner'), 'open_inspect_session') != 'github_pr'`
      )
      .bind(now, now, id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async markDeleteFailed(
    id: string,
    error: string,
    retryAfter: number,
    now = Date.now()
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE session_resources
         SET status = 'delete_failed',
             last_error = ?,
             delete_after = ?,
             updated_at = ?
         WHERE id = ?
           AND deleted_at IS NULL
           AND COALESCE(json_extract(metadata, '$.lifecycleOwner'), 'open_inspect_session') != 'github_pr'`
      )
      .bind(error.slice(0, 1000), retryAfter, now, id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async listBySession(sessionId: string): Promise<SessionResourceRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM session_resources
         WHERE session_id = ?
         ORDER BY created_at DESC`
      )
      .bind(sessionId)
      .all<SessionResourceRow>();

    return result.results ?? [];
  }
}

function resourcePrimaryKey(
  sessionId: string,
  resourceType: SessionResourceType,
  resourceId: string
): string {
  return `${sessionId}:${resourceType}:${resourceId}`;
}
