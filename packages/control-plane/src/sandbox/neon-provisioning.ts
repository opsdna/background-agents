import type { SessionRow } from "../session/types";

const DEFAULT_NEON_API_BASE_URL = "https://console.neon.tech/api/v2";
const DEFAULT_BRANCH_NAME_PREFIX = "open-inspect";
const DEFAULT_OPERATION_WAIT_MS = 30_000;
const DEFAULT_OPERATION_POLL_INTERVAL_MS = 1_000;
const NEON_BRANCH_ID_PATTERN = /^br-[a-z0-9-]{1,57}$/;

export const NEON_CONTROL_SECRET_KEYS = new Set([
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "NEON_PARENT_BRANCH_ID",
  "NEON_DATABASE_NAME",
  "NEON_ROLE_NAME",
  "NEON_BRANCH_NAME_PREFIX",
  "NEON_API_BASE_URL",
  "NEON_OPERATION_WAIT_MS",
  "NEON_OPERATION_POLL_INTERVAL_MS",
]);

const REQUIRED_NEON_CONFIG_KEYS = [
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "NEON_DATABASE_NAME",
  "NEON_ROLE_NAME",
] as const;

export class NeonProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeonProvisioningError";
  }
}

export interface NeonProvisioningConfig {
  apiKey: string;
  projectId: string;
  parentBranchId?: string;
  databaseName: string;
  roleName: string;
  branchNamePrefix: string;
  apiBaseUrl: string;
  operationWaitMs: number;
  operationPollIntervalMs: number;
}

export interface NeonProvisionedEnv {
  env: Record<string, string>;
  projectId: string;
  branchId: string;
  branchName: string;
}

interface NeonBranch {
  id: string;
  name: string;
}

interface NeonOperation {
  id: string;
  status?: string;
}

interface NeonProvisionerOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function hasNeonProvisioningConfig(env: Record<string, string>): boolean {
  return Object.keys(env).some((key) => NEON_CONTROL_SECRET_KEYS.has(key.toUpperCase()));
}

export function stripNeonControlConfig(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!NEON_CONTROL_SECRET_KEYS.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  return result;
}

export function readNeonProvisioningConfig(
  env: Record<string, string>
): NeonProvisioningConfig | null {
  if (!hasNeonProvisioningConfig(env)) {
    return null;
  }

  const missing = REQUIRED_NEON_CONFIG_KEYS.filter((key) => !nonEmpty(env[key]));
  if (missing.length > 0) {
    throw new NeonProvisioningError(`Neon provisioning config is missing: ${missing.join(", ")}`);
  }

  return {
    apiKey: env.NEON_API_KEY,
    projectId: env.NEON_PROJECT_ID,
    parentBranchId: nonEmpty(env.NEON_PARENT_BRANCH_ID) ? env.NEON_PARENT_BRANCH_ID : undefined,
    databaseName: env.NEON_DATABASE_NAME,
    roleName: env.NEON_ROLE_NAME,
    branchNamePrefix: nonEmpty(env.NEON_BRANCH_NAME_PREFIX)
      ? env.NEON_BRANCH_NAME_PREFIX
      : DEFAULT_BRANCH_NAME_PREFIX,
    apiBaseUrl: nonEmpty(env.NEON_API_BASE_URL) ? env.NEON_API_BASE_URL : DEFAULT_NEON_API_BASE_URL,
    operationWaitMs: readPositiveInteger(env.NEON_OPERATION_WAIT_MS, DEFAULT_OPERATION_WAIT_MS),
    operationPollIntervalMs: readPositiveInteger(
      env.NEON_OPERATION_POLL_INTERVAL_MS,
      DEFAULT_OPERATION_POLL_INTERVAL_MS
    ),
  };
}

export async function provisionNeonDatabaseEnv(
  secrets: Record<string, string>,
  session: SessionRow,
  options: NeonProvisionerOptions = {}
): Promise<NeonProvisionedEnv | null> {
  const config = readNeonProvisioningConfig(secrets);
  if (!config) return null;

  const provisioner = new NeonBranchProvisioner(config, options);
  return provisioner.provisionForSession(session);
}

export async function deleteNeonBranch(
  config: NeonProvisioningConfig,
  branchId: string,
  options: NeonProvisionerOptions & { hardDelete?: boolean } = {}
): Promise<void> {
  const provisioner = new NeonBranchProvisioner(config, options);
  await provisioner.deleteBranch(branchId, options.hardDelete ?? false);
}

export function buildNeonBranchName(
  session: Pick<SessionRow, "id" | "session_name" | "repo_owner" | "repo_name">,
  prefix = DEFAULT_BRANCH_NAME_PREFIX
): string {
  const sessionId = session.session_name || session.id;
  const parts = [
    sanitizeBranchSegment(prefix),
    sanitizeBranchSegment(session.repo_owner),
    sanitizeBranchSegment(session.repo_name),
    sanitizeBranchSegment(sessionId),
  ].filter(Boolean);

  const name = parts.join("-");
  return trimBranchName(name) || `${DEFAULT_BRANCH_NAME_PREFIX}-${Date.now()}`;
}

class NeonBranchProvisioner {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: NeonProvisioningConfig,
    options: NeonProvisionerOptions = {}
  ) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async provisionForSession(session: SessionRow): Promise<NeonProvisionedEnv> {
    const branchName = buildNeonBranchName(session, this.config.branchNamePrefix);
    const branch = await this.findOrCreateBranch(branchName);
    const uri = await this.getConnectionUri(branch.id);

    return {
      projectId: this.config.projectId,
      branchId: branch.id,
      branchName: branch.name,
      env: {
        DATABASE_URL: uri,
        OPSDNA_TEST_PG_DATABASE_URL: uri,
        DEV_DATABASE_BACKEND: "postgres",
        OPEN_INSPECT_NEON_BRANCH_ID: branch.id,
        OPEN_INSPECT_NEON_BRANCH_NAME: branch.name,
      },
    };
  }

  async deleteBranch(branchId: string, hardDelete: boolean): Promise<void> {
    const query = new URLSearchParams({
      hard_delete: hardDelete ? "true" : "false",
    });
    await this.requestNoContent(
      `/projects/{project_id}/branches/${encodeURIComponent(branchId)}?${query.toString()}`,
      { method: "DELETE" }
    );
  }

  private async findOrCreateBranch(branchName: string): Promise<NeonBranch> {
    const existing = await this.findBranchByName(branchName);
    if (existing) return existing;

    const branch: Record<string, string> = { name: branchName };
    const parentBranchId = await this.resolveParentBranchId();
    if (parentBranchId) {
      branch.parent_id = parentBranchId;
    }

    const response = await this.requestJson("/projects/{project_id}/branches", {
      method: "POST",
      body: JSON.stringify({
        branch,
        endpoints: [{ type: "read_write" }],
      }),
    });

    const created = parseBranch(response);
    if (!created) {
      throw new NeonProvisioningError("Neon branch creation response did not include a branch id");
    }

    await this.waitForOperations(parseOperations(response));
    return created;
  }

  private async findBranchByName(branchName: string): Promise<NeonBranch | null> {
    const query = new URLSearchParams({
      search: branchName,
      limit: "100",
    });
    const response = await this.requestJson(`/projects/{project_id}/branches?${query.toString()}`);
    const responseRecord = asRecord(response);
    const branches = Array.isArray(responseRecord?.branches) ? responseRecord.branches : [];

    for (const candidate of branches) {
      const branch = parseBranch({ branch: candidate });
      if (branch?.name === branchName) {
        return branch;
      }
    }

    return null;
  }

  private async resolveParentBranchId(): Promise<string | undefined> {
    const ref = this.config.parentBranchId?.trim();
    if (!ref) return undefined;

    const extractedId = extractNeonBranchId(ref);
    if (extractedId) return extractedId;

    const branch = await this.findBranchByName(ref);
    if (branch) return branch.id;

    throw new NeonProvisioningError(`Neon parent branch not found: ${ref}`);
  }

  private async getConnectionUri(branchId: string): Promise<string> {
    const query = new URLSearchParams({
      branch_id: branchId,
      database_name: this.config.databaseName,
      role_name: this.config.roleName,
      pooled: "false",
    });
    const response = await this.requestJson(
      `/projects/{project_id}/connection_uri?${query.toString()}`
    );
    const responseRecord = asRecord(response);
    const uri = typeof responseRecord?.uri === "string" ? responseRecord.uri : "";
    if (!uri) {
      throw new NeonProvisioningError("Neon connection URI response did not include a uri");
    }
    return uri;
  }

  private async waitForOperations(operations: NeonOperation[]): Promise<void> {
    const pending = operations.filter((operation) => isOperationPending(operation.status));
    if (pending.length === 0) {
      const failed = operations.find((operation) => isOperationFailure(operation.status));
      if (failed) {
        throw new NeonProvisioningError(
          `Neon operation ${failed.id} failed with status ${failed.status}`
        );
      }
      return;
    }

    const deadline = Date.now() + this.config.operationWaitMs;
    for (const operation of pending) {
      while (Date.now() <= deadline) {
        const response = await this.requestJson(
          `/projects/{project_id}/operations/${operation.id}`
        );
        const responseRecord = asRecord(response);
        const operationRecord = asRecord(responseRecord?.operation);
        const status = typeof operationRecord?.status === "string" ? operationRecord.status : "";
        if (status === "finished") break;
        if (isOperationFailure(status)) {
          throw new NeonProvisioningError(
            `Neon operation ${operation.id} failed with status ${status}`
          );
        }
        await this.sleep(this.config.operationPollIntervalMs);
      }

      if (Date.now() > deadline) {
        throw new NeonProvisioningError(`Timed out waiting for Neon operation ${operation.id}`);
      }
    }
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    return response.json();
  }

  private async requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
    await this.request(path, init);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    if (init.body) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetchFn(this.url(path), {
      ...init,
      headers,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new NeonProvisioningError(
        `Neon API request failed: ${response.status} ${response.statusText}${formatErrorBody(body)}`
      );
    }

    return response;
  }

  private url(path: string): string {
    return `${this.config.apiBaseUrl.replace(/\/+$/, "")}${path.replace(
      "{project_id}",
      encodeURIComponent(this.config.projectId)
    )}`;
  }
}

function parseBranch(response: unknown): NeonBranch | null {
  const responseRecord = asRecord(response);
  const branch = asRecord(responseRecord?.branch);
  if (!branch || typeof branch.id !== "string" || typeof branch.name !== "string") {
    return null;
  }
  return { id: branch.id, name: branch.name };
}

function parseOperations(response: unknown): NeonOperation[] {
  const responseRecord = asRecord(response);
  if (!Array.isArray(responseRecord?.operations)) return [];
  return responseRecord.operations
    .filter((operation): operation is Record<string, unknown> & { id: string } => {
      const operationRecord = asRecord(operation);
      return typeof operationRecord?.id === "string";
    })
    .map((operation) => ({
      id: operation.id,
      status: typeof operation.status === "string" ? operation.status : undefined,
    }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sanitizeBranchSegment(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function trimBranchName(value: string): string {
  return value.slice(0, 120).replace(/-+$/g, "");
}

function extractNeonBranchId(value: string): string | null {
  const trimmed = value.trim();
  if (NEON_BRANCH_ID_PATTERN.test(trimmed)) return trimmed;
  return trimmed.match(/\b(br-[a-z0-9-]{1,57})\b/)?.[1] ?? null;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!nonEmpty(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isOperationPending(status: string | undefined): boolean {
  return status === "scheduling" || status === "running";
}

function isOperationFailure(status: string | undefined): boolean {
  return status === "failed" || status === "cancelled";
}

function formatErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `: ${trimmed.slice(0, 500)}`;
}
