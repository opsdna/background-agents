import type { SessionStatus } from "../types";
import type { Logger } from "../logger";
import { GlobalSecretsStore } from "../db/global-secrets";
import {
  SessionResourceStore,
  type SessionResourceRow,
  type SessionResourceType,
} from "../db/session-resources";
import {
  deleteNeonBranch,
  readNeonProvisioningConfig,
  type NeonProvisioningConfig,
} from "../sandbox/neon-provisioning";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SESSION_RESOURCE_DELETE_DELAYS_MS: Partial<Record<SessionStatus, number>> = {
  cancelled: 0,
  failed: DAY_MS,
  completed: 3 * DAY_MS,
  archived: 3 * DAY_MS,
};

const DELETE_RETRY_DELAY_MS = HOUR_MS;

export interface SessionResourceStatusResult {
  action: "cleared" | "marked" | "ignored";
  count: number;
  deleteAfter?: number;
}

export interface SessionResourceCleanupResult {
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
}

export class SessionResourceCleanupService {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string | undefined,
    private readonly log?: Logger,
    private readonly fetchFn?: typeof fetch
  ) {}

  async handleSessionStatus(
    sessionId: string,
    status: SessionStatus,
    now = Date.now()
  ): Promise<SessionResourceStatusResult> {
    const store = new SessionResourceStore(this.db);
    const delayMs = deleteDelayForSessionStatus(status);

    if (status === "active") {
      const count = await store.clearPendingDeletion(sessionId, now);
      return { action: "cleared", count };
    }

    if (delayMs === null) {
      return { action: "ignored", count: 0 };
    }

    const deleteAfter = now + delayMs;
    const count = await store.markSessionForDeletion(sessionId, deleteAfter, status, now);
    return { action: "marked", count, deleteAfter };
  }

  async processDue(now = Date.now(), limit = 25): Promise<SessionResourceCleanupResult> {
    const store = new SessionResourceStore(this.db);
    const resources = await store.listDueForDeletion(now, limit);
    if (resources.length === 0) {
      return { scanned: 0, deleted: 0, failed: 0, skipped: 0 };
    }

    const config = await this.readNeonConfig();
    let deleted = 0;
    let failed = 0;
    let skipped = 0;

    for (const resource of resources) {
      if (resource.resource_type !== "neon_branch") {
        skipped++;
        continue;
      }

      if (!config) {
        failed++;
        await store.markDeleteFailed(
          resource.id,
          "Neon cleanup config is not available",
          now + DELETE_RETRY_DELAY_MS,
          now
        );
        continue;
      }

      const resourceConfig = configForResource(config, resource);
      try {
        await store.markDeleting(resource.id, now);
        await deleteNeonBranch(resourceConfig, resource.resource_id, {
          fetchFn: this.fetchFn,
          hardDelete: true,
          ignoreNotFound: true,
        });
        await store.markDeleted(resource.id, Date.now());
        deleted++;
        this.log?.info("Deleted session Neon branch", {
          event: "session_resource.deleted",
          session_id: resource.session_id,
          branch_id: resource.resource_id,
          branch_name: resource.resource_name,
          resource_id: resource.id,
        });
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        await store.markDeleteFailed(resource.id, message, now + DELETE_RETRY_DELAY_MS, now);
        this.log?.warn("Failed to delete session Neon branch", {
          event: "session_resource.delete_failed",
          session_id: resource.session_id,
          branch_id: resource.resource_id,
          branch_name: resource.resource_name,
          resource_id: resource.id,
          error: message,
        });
      }
    }

    return { scanned: resources.length, deleted, failed, skipped };
  }

  private async readNeonConfig(): Promise<NeonProvisioningConfig | null> {
    if (!this.encryptionKey) return null;

    try {
      const secrets = await new GlobalSecretsStore(
        this.db,
        this.encryptionKey
      ).getDecryptedSecrets();
      return readNeonProvisioningConfig(secrets);
    } catch (error) {
      this.log?.warn("Failed to load Neon cleanup config", {
        event: "session_resource.neon_config_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export function deleteDelayForSessionStatus(status: SessionStatus): number | null {
  return SESSION_RESOURCE_DELETE_DELAYS_MS[status] ?? null;
}

function configForResource(
  config: NeonProvisioningConfig,
  resource: Pick<SessionResourceRow, "metadata">
): NeonProvisioningConfig {
  const metadata = parseMetadata(resource.metadata);
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId : config.projectId;
  return projectId === config.projectId ? config : { ...config, projectId };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isCleanableResourceType(value: string): value is SessionResourceType {
  return value === "neon_branch";
}
