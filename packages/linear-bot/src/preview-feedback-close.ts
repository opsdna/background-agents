import type { Context } from "hono";
import { buildInternalAuthHeaders } from "@open-inspect/shared";

import type { Env } from "./types";
import {
  authenticatePreviewFeedbackRequest,
  PREVIEW_FEEDBACK_SIGNATURE_WINDOW_SECONDS,
} from "./preview-feedback-auth";

const MAX_CLOSE_REQUEST_BYTES = 16 * 1024;
const CLOSE_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

interface PreviewFeedbackClosePayload {
  schemaVersion: 1;
  repository: string;
  deploymentKind: "feature_preview";
  previewId: string;
  prNumber: number;
  branch: string;
  closedAt: string;
  reason: "pull_request_closed";
}

export async function handlePreviewFeedbackClose(
  c: Context<{ Bindings: Env }>,
  options: { now?: () => number } = {}
): Promise<Response> {
  const body = await c.req.text();
  const idempotencyKey = c.req.header("idempotency-key") ?? "";
  if (!isUuid(idempotencyKey)) return failure(c, 401, "invalid_signature");

  const nowMs = options.now?.() ?? Date.now();
  const auth = await authenticatePreviewFeedbackRequest(c, body, {
    maxBytes: MAX_CLOSE_REQUEST_BYTES,
    nowMs,
  });
  if (!auth.ok) return failure(c, auth.status, auth.reason);

  const resultKey = `preview-feedback:close:${idempotencyKey}`;
  const prior = await c.env.LINEAR_KV.get(resultKey);
  if (prior) return new Response(prior, jsonInit(200));

  const nonceKey = `preview-feedback:nonce:${auth.nonce}`;
  if (await c.env.LINEAR_KV.get(nonceKey)) return failure(c, 409, "nonce_replayed");
  await c.env.LINEAR_KV.put(nonceKey, "1", {
    expirationTtl: PREVIEW_FEEDBACK_SIGNATURE_WINDOW_SECONDS,
  });

  const payload = parseClosePayload(body);
  if (!payload) return failure(c, 400, "invalid_request");
  if (!isAllowed(payload.repository, c.env.PREVIEW_FEEDBACK_ALLOWED_REPOSITORIES)) {
    return failure(c, 403, "repository_not_allowed");
  }

  const organizationId = c.env.PREVIEW_FEEDBACK_ORGANIZATION_ID;
  if (!organizationId) return failure(c, 503, "not_configured");
  const channelKey = `${organizationId}:${payload.repository}:feature_preview:${payload.previewId}`;
  const response = await c.env.CONTROL_PLANE.fetch(
    "https://internal/preview-feedback/channels/close",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await buildInternalAuthHeaders(c.env.INTERNAL_CALLBACK_SECRET)),
      },
      body: JSON.stringify({
        channelKey,
        repository: payload.repository,
        deploymentKind: payload.deploymentKind,
        previewId: payload.previewId,
        prNumber: payload.prNumber,
        baseBranch: payload.branch,
        now: nowMs,
      }),
    }
  );
  if (!response.ok) return failure(c, 502, "channel_close_failed");

  const controlPlaneResult = (await response.json()) as {
    closed?: boolean;
    sessionCleanup?: string;
  };
  const result = JSON.stringify({
    closed: controlPlaneResult.closed === true,
    sessionCleanup: controlPlaneResult.sessionCleanup ?? "not_attached",
  });
  await c.env.LINEAR_KV.put(resultKey, result, {
    expirationTtl: CLOSE_IDEMPOTENCY_TTL_SECONDS,
  });
  return new Response(result, jsonInit(200));
}

function parseClosePayload(body: string): PreviewFeedbackClosePayload | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.repository !== "string" ||
    value.repository.length < 3 ||
    value.repository.length > 300 ||
    value.deploymentKind !== "feature_preview" ||
    typeof value.prNumber !== "number" ||
    !Number.isSafeInteger(value.prNumber) ||
    value.prNumber < 1 ||
    value.previewId !== `pr-${value.prNumber}` ||
    typeof value.branch !== "string" ||
    value.branch.length < 1 ||
    value.branch.length > 500 ||
    typeof value.closedAt !== "string" ||
    !Number.isFinite(Date.parse(value.closedAt)) ||
    value.reason !== "pull_request_closed"
  ) {
    return null;
  }
  return value as unknown as PreviewFeedbackClosePayload;
}

function isAllowed(repository: string, configured: string | undefined): boolean {
  return (configured ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(repository.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function failure(c: Context, status: number, reason: string): Response {
  return c.json({ error: "Preview feedback close failed", reason }, status as 400);
}

function jsonInit(status: number): ResponseInit {
  return { status, headers: { "content-type": "application/json; charset=UTF-8" } };
}
