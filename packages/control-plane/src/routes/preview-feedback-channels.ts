import {
  PreviewFeedbackChannelStore,
  type PreviewFeedbackChannelStatus,
} from "../db/preview-feedback-channels";
import type { Env } from "../types";
import { error, json, parseJsonBody, parsePattern, type Route } from "./shared";

const MAX_BODY_BYTES = 16 * 1024;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 2 * 60 * 1000;
const STATUSES = new Set<PreviewFeedbackChannelStatus>([
  "provisioning",
  "tracking",
  "agent_active",
  "agent_failed",
  "closed",
  "expired",
]);

interface ClaimBody {
  channelKey?: unknown;
  linearOrganizationId?: unknown;
  repository?: unknown;
  deploymentKind?: unknown;
  previewId?: unknown;
  prNumber?: unknown;
  baseBranch?: unknown;
  portalUrl?: unknown;
  leaseOwner?: unknown;
  now?: unknown;
  leaseDurationMs?: unknown;
  expiresAt?: unknown;
}

interface GetBody {
  channelKey?: unknown;
}

interface UpdateBody extends GetBody {
  leaseOwner?: unknown;
  now?: unknown;
  status?: unknown;
  baseSha?: unknown;
  sessionSyncedSha?: unknown;
  parentLinearIssueId?: unknown;
  parentLinearIssueIdentifier?: unknown;
  openInspectSessionId?: unknown;
  linearAgentSessionId?: unknown;
}

async function boundedBody<T>(request: Request): Promise<T | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return error("Payload too large", 413);
  }
  return parseJsonBody<T>(request);
}

function requiredString(value: unknown, maxLength = 500): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function optionalString(value: unknown, maxLength = 500): string | undefined | null {
  if (value === undefined) return undefined;
  return requiredString(value, maxLength);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

async function claimChannel(request: Request, env: Env): Promise<Response> {
  const body = await boundedBody<ClaimBody>(request);
  if (body instanceof Response) return body;
  const channelKey = requiredString(body.channelKey, 1000);
  const organizationId = requiredString(body.linearOrganizationId);
  const repository = requiredString(body.repository, 300);
  const previewId = requiredString(body.previewId, 100);
  const baseBranch = requiredString(body.baseBranch, 500);
  const portalUrl = requiredString(body.portalUrl, 2000);
  const leaseOwner = requiredString(body.leaseOwner);
  const kind = body.deploymentKind;
  if (
    !channelKey ||
    !organizationId ||
    !repository ||
    !previewId ||
    !baseBranch ||
    !portalUrl ||
    !leaseOwner ||
    (kind !== "feature_preview" && kind !== "staging") ||
    !(body.prNumber === null || safeInteger(body.prNumber)) ||
    !safeInteger(body.now) ||
    !safeInteger(body.leaseDurationMs) ||
    body.leaseDurationMs < MIN_LEASE_MS ||
    body.leaseDurationMs > MAX_LEASE_MS ||
    !safeInteger(body.expiresAt) ||
    body.expiresAt <= body.now
  ) {
    return error("Invalid preview feedback channel claim", 400);
  }
  const expectedPreviewId = kind === "staging" ? "staging" : `pr-${body.prNumber}`;
  const expectedKey = `${organizationId}:${repository}:${kind}:${expectedPreviewId}`;
  if (previewId !== expectedPreviewId || channelKey !== expectedKey) {
    return error("Preview feedback channel identity mismatch", 400);
  }
  try {
    const portal = new URL(portalUrl);
    if (portal.origin !== portalUrl) return error("portalUrl must be an origin", 400);
  } catch {
    return error("Invalid portalUrl", 400);
  }
  const result = await new PreviewFeedbackChannelStore(env.DB).claim({
    channelKey,
    linearOrganizationId: organizationId,
    repository,
    deploymentKind: kind,
    previewId,
    prNumber: body.prNumber,
    baseBranch,
    portalUrl,
    leaseOwner,
    now: body.now,
    leaseDurationMs: body.leaseDurationMs,
    expiresAt: body.expiresAt,
  });
  return json(result, result.claimed ? 200 : 409);
}

async function getChannel(request: Request, env: Env): Promise<Response> {
  const body = await boundedBody<GetBody>(request);
  if (body instanceof Response) return body;
  const channelKey = requiredString(body.channelKey, 1000);
  if (!channelKey) return error("channelKey is required", 400);
  const channel = await new PreviewFeedbackChannelStore(env.DB).get(channelKey);
  return channel ? json({ channel }) : error("Preview feedback channel not found", 404);
}

async function getChannelByParent(request: Request, env: Env): Promise<Response> {
  const body = await boundedBody<{ parentLinearIssueId?: unknown; channelKey?: unknown }>(request);
  if (body instanceof Response) return body;
  const parentLinearIssueId = requiredString(body.parentLinearIssueId);
  const channelKey = requiredString(body.channelKey, 1000);
  if (!parentLinearIssueId || !channelKey) {
    return error("parentLinearIssueId and channelKey are required", 400);
  }
  const channel = await new PreviewFeedbackChannelStore(env.DB).getByParentIssue(
    parentLinearIssueId
  );
  return channel?.channelKey === channelKey
    ? json({ channel })
    : error("Preview feedback channel not found", 404);
}

async function updateChannel(request: Request, env: Env): Promise<Response> {
  const body = await boundedBody<UpdateBody>(request);
  if (body instanceof Response) return body;
  const channelKey = requiredString(body.channelKey, 1000);
  const leaseOwner = requiredString(body.leaseOwner);
  const status = body.status;
  const optional = {
    sessionSyncedSha: optionalString(body.sessionSyncedSha, 40),
    parentLinearIssueId: optionalString(body.parentLinearIssueId),
    parentLinearIssueIdentifier: optionalString(body.parentLinearIssueIdentifier),
    openInspectSessionId: optionalString(body.openInspectSessionId),
    linearAgentSessionId: optionalString(body.linearAgentSessionId),
  };
  if (
    !channelKey ||
    !leaseOwner ||
    !safeInteger(body.now) ||
    typeof status !== "string" ||
    !STATUSES.has(status as PreviewFeedbackChannelStatus) ||
    (body.baseSha !== undefined && !validSha(body.baseSha)) ||
    (body.sessionSyncedSha !== undefined && !validSha(body.sessionSyncedSha)) ||
    Object.values(optional).some((value) => value === null)
  ) {
    return error("Invalid preview feedback channel update", 400);
  }
  const channel = await new PreviewFeedbackChannelStore(env.DB).update({
    channelKey,
    leaseOwner,
    now: body.now,
    status: status as PreviewFeedbackChannelStatus,
    ...(typeof body.baseSha === "string" ? { baseSha: body.baseSha } : {}),
    ...Object.fromEntries(
      Object.entries(optional).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    ),
  });
  return channel ? json({ channel }) : error("Preview feedback channel lease lost", 409);
}

export const previewFeedbackChannelRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/preview-feedback/channels/claim"),
    handler: (request, env) => claimChannel(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/preview-feedback/channels/get"),
    handler: (request, env) => getChannel(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/preview-feedback/channels/update"),
    handler: (request, env) => updateChannel(request, env),
  },
  {
    method: "POST",
    pattern: parsePattern("/preview-feedback/channels/by-parent"),
    handler: (request, env) => getChannelByParent(request, env),
  },
];
