export type PreviewFeedbackChannelStatus =
  | "provisioning"
  | "tracking"
  | "agent_active"
  | "agent_failed"
  | "closed"
  | "expired";

export interface PreviewFeedbackChannel {
  channelKey: string;
  linearOrganizationId: string;
  repository: string;
  deploymentKind: "feature_preview" | "staging";
  previewId: string;
  prNumber: number | null;
  baseBranch: string;
  baseSha: string | null;
  sessionSyncedSha: string | null;
  portalUrl: string;
  parentLinearIssueId: string | null;
  parentLinearIssueIdentifier: string | null;
  openInspectSessionId: string | null;
  linearAgentSessionId: string | null;
  status: PreviewFeedbackChannelStatus;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PreviewFeedbackChannelRow {
  channel_key: string;
  linear_organization_id: string;
  repository: string;
  deployment_kind: "feature_preview" | "staging";
  preview_id: string;
  pr_number: number | null;
  base_branch: string;
  base_sha: string | null;
  session_synced_sha: string | null;
  portal_url: string;
  parent_linear_issue_id: string | null;
  parent_linear_issue_identifier: string | null;
  open_inspect_session_id: string | null;
  linear_agent_session_id: string | null;
  status: PreviewFeedbackChannelStatus;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface ClaimPreviewFeedbackChannelInput {
  channelKey: string;
  linearOrganizationId: string;
  repository: string;
  deploymentKind: "feature_preview" | "staging";
  previewId: string;
  prNumber: number | null;
  baseBranch: string;
  portalUrl: string;
  leaseOwner: string;
  now: number;
  leaseDurationMs: number;
  expiresAt: number;
}

export interface UpdatePreviewFeedbackChannelInput {
  channelKey: string;
  leaseOwner: string;
  now: number;
  status: PreviewFeedbackChannelStatus;
  baseSha?: string;
  sessionSyncedSha?: string;
  parentLinearIssueId?: string;
  parentLinearIssueIdentifier?: string;
  openInspectSessionId?: string;
  linearAgentSessionId?: string;
}

function toChannel(row: PreviewFeedbackChannelRow): PreviewFeedbackChannel {
  return {
    channelKey: row.channel_key,
    linearOrganizationId: row.linear_organization_id,
    repository: row.repository,
    deploymentKind: row.deployment_kind,
    previewId: row.preview_id,
    prNumber: row.pr_number,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    sessionSyncedSha: row.session_synced_sha,
    portalUrl: row.portal_url,
    parentLinearIssueId: row.parent_linear_issue_id,
    parentLinearIssueIdentifier: row.parent_linear_issue_identifier,
    openInspectSessionId: row.open_inspect_session_id,
    linearAgentSessionId: row.linear_agent_session_id,
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export class PreviewFeedbackChannelStore {
  constructor(private readonly db: D1Database) {}

  async get(channelKey: string): Promise<PreviewFeedbackChannel | null> {
    const row = await this.db
      .prepare("SELECT * FROM preview_feedback_channels WHERE channel_key = ?")
      .bind(channelKey)
      .first<PreviewFeedbackChannelRow>();
    return row ? toChannel(row) : null;
  }

  async getByParentIssue(parentLinearIssueId: string): Promise<PreviewFeedbackChannel | null> {
    const row = await this.db
      .prepare("SELECT * FROM preview_feedback_channels WHERE parent_linear_issue_id = ?")
      .bind(parentLinearIssueId)
      .first<PreviewFeedbackChannelRow>();
    return row ? toChannel(row) : null;
  }

  async claim(
    input: ClaimPreviewFeedbackChannelInput
  ): Promise<{ claimed: boolean; channel: PreviewFeedbackChannel }> {
    const leaseExpiresAt = input.now + input.leaseDurationMs;
    await this.db
      .prepare(
        `INSERT INTO preview_feedback_channels (
           channel_key, linear_organization_id, repository, deployment_kind, preview_id,
           pr_number, base_branch, portal_url, status, lease_owner, lease_expires_at,
           created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)
         ON CONFLICT(channel_key) DO UPDATE SET
           lease_owner = excluded.lease_owner,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at,
           expires_at = MAX(preview_feedback_channels.expires_at, excluded.expires_at)
         WHERE preview_feedback_channels.status NOT IN ('closed', 'expired')
           AND (
             preview_feedback_channels.lease_owner IS NULL
             OR preview_feedback_channels.lease_expires_at <= ?
             OR preview_feedback_channels.lease_owner = ?
           )`
      )
      .bind(
        input.channelKey,
        input.linearOrganizationId,
        input.repository,
        input.deploymentKind,
        input.previewId,
        input.prNumber,
        input.baseBranch,
        input.portalUrl,
        input.leaseOwner,
        leaseExpiresAt,
        input.now,
        input.now,
        input.expiresAt,
        input.now,
        input.leaseOwner
      )
      .run();

    const channel = await this.get(input.channelKey);
    if (!channel) throw new Error("Preview feedback channel claim did not persist");
    return {
      claimed: channel.leaseOwner === input.leaseOwner && channel.leaseExpiresAt === leaseExpiresAt,
      channel,
    };
  }

  async update(input: UpdatePreviewFeedbackChannelInput): Promise<PreviewFeedbackChannel | null> {
    const result = await this.db
      .prepare(
        `UPDATE preview_feedback_channels SET
           status = ?,
           base_sha = COALESCE(?, base_sha),
           session_synced_sha = COALESCE(?, session_synced_sha),
           parent_linear_issue_id = COALESCE(?, parent_linear_issue_id),
           parent_linear_issue_identifier = COALESCE(?, parent_linear_issue_identifier),
           open_inspect_session_id = COALESCE(?, open_inspect_session_id),
           linear_agent_session_id = COALESCE(?, linear_agent_session_id),
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
         WHERE channel_key = ? AND lease_owner = ? AND lease_expires_at > ?`
      )
      .bind(
        input.status,
        input.baseSha ?? null,
        input.sessionSyncedSha ?? null,
        input.parentLinearIssueId ?? null,
        input.parentLinearIssueIdentifier ?? null,
        input.openInspectSessionId ?? null,
        input.linearAgentSessionId ?? null,
        input.now,
        input.channelKey,
        input.leaseOwner,
        input.now
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.get(input.channelKey);
  }

  async attachOpenInspectSession(input: {
    parentLinearIssueId: string;
    linearAgentSessionId: string;
    openInspectSessionId: string;
    now: number;
  }): Promise<PreviewFeedbackChannel | null> {
    const result = await this.db
      .prepare(
        `UPDATE preview_feedback_channels SET
           open_inspect_session_id = ?, status = 'agent_active', updated_at = ?
         WHERE parent_linear_issue_id = ? AND linear_agent_session_id = ?`
      )
      .bind(
        input.openInspectSessionId,
        input.now,
        input.parentLinearIssueId,
        input.linearAgentSessionId
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return this.getByParentIssue(input.parentLinearIssueId);
  }
}
