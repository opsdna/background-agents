import type { Context } from "hono";
import { timingSafeEqual } from "@open-inspect/shared";

import type { Env } from "./types";
import {
  createIssue,
  getLinearClientOrThrow,
  type CreatedLinearIssue,
} from "./utils/linear-client";

const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const SIGNATURE_WINDOW_SECONDS = 5 * 60;
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const NONCE_TTL_SECONDS = SIGNATURE_WINDOW_SECONDS;

interface PreviewFeedbackEnvelope {
  schemaVersion: 1;
  action: "track" | "fix";
  comment: string;
  feedbackId: string;
  idempotencyKey: string;
  reporter: { identityId: string; displayName: string };
  deployment: {
    kind: "feature_preview" | "staging";
    repository: string;
    prNumber: number | null;
    branch: string;
    commitSha: string;
    portalUrl: string;
  };
  page: { url: string; path: string };
  selection: {
    componentName?: string;
    source?: { file: string; line?: number; column?: number };
    tagName: string;
    id?: string;
    testId?: string;
    role?: string;
    classNames?: readonly string[];
    ancestors?: ReadonlyArray<{
      tagName: string;
      id?: string;
      testId?: string;
      role?: string;
      classNames?: readonly string[];
    }>;
    accessibleName?: string;
    textSnippet?: string;
  };
}

export interface PreviewFeedbackIngestServices {
  now?: () => number;
  createLinearIssue?: (env: Env, envelope: PreviewFeedbackEnvelope) => Promise<CreatedLinearIssue>;
}

export async function handlePreviewFeedbackIngest(
  c: Context<{ Bindings: Env }>,
  services: PreviewFeedbackIngestServices = {}
): Promise<Response> {
  const secret = c.env.PREVIEW_FEEDBACK_HMAC_SECRET;
  if (!secret || secret.length < 32) return reason(c, 503, "not_configured");

  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    return reason(c, 413, "request_too_large");
  }
  const idempotencyKey = c.req.header("idempotency-key") ?? "";
  const timestamp = c.req.header("x-opsdna-feedback-timestamp") ?? "";
  const nonce = c.req.header("x-opsdna-feedback-nonce") ?? "";
  const signature = c.req.header("x-opsdna-feedback-signature") ?? "";
  if (!isUuid(idempotencyKey) || !isUuid(nonce) || !/^\d{10}$/u.test(timestamp)) {
    return reason(c, 401, "invalid_signature");
  }
  const nowSeconds = Math.floor((services.now?.() ?? Date.now()) / 1000);
  const timestampSeconds = Number(timestamp);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_WINDOW_SECONDS) {
    return reason(c, 401, "expired_signature");
  }
  const bodyHash = await sha256Hex(body);
  const expected = `v1=${await hmacHex(secret, `v1\n${timestamp}\n${nonce}\n${bodyHash}`)}`;
  if (!timingSafeEqual(signature, expected)) return reason(c, 401, "invalid_signature");

  const idempotencyStorageKey = `preview-feedback:idempotency:${idempotencyKey}`;
  const prior = await c.env.LINEAR_KV.get(idempotencyStorageKey);
  if (prior) return new Response(prior, jsonInit(201));

  const nonceKey = `preview-feedback:nonce:${nonce}`;
  if (await c.env.LINEAR_KV.get(nonceKey)) return reason(c, 409, "nonce_replayed");
  await c.env.LINEAR_KV.put(nonceKey, "1", { expirationTtl: NONCE_TTL_SECONDS });

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return reason(c, 400, "invalid_request");
  }
  const envelope = parseEnvelope(raw);
  if (!envelope || envelope.idempotencyKey !== idempotencyKey) {
    return reason(c, 400, "invalid_request");
  }
  if (!isAllowed(envelope.deployment.repository, c.env.PREVIEW_FEEDBACK_ALLOWED_REPOSITORIES)) {
    return reason(c, 403, "repository_not_allowed");
  }
  const portalOrigin = safeOrigin(envelope.deployment.portalUrl);
  if (
    portalOrigin === null ||
    portalOrigin !== safeOrigin(envelope.page.url) ||
    !isOriginAllowed(portalOrigin, c.env.PREVIEW_FEEDBACK_ALLOWED_PORTAL_ORIGINS)
  ) {
    return reason(c, 403, "portal_origin_not_allowed");
  }

  let issue: CreatedLinearIssue;
  try {
    issue = await (services.createLinearIssue ?? createPreviewFeedbackIssue)(c.env, envelope);
  } catch {
    return reason(c, 502, "linear_issue_creation_failed");
  }
  const response = {
    feedbackId: envelope.feedbackId,
    linearIssue: issue,
    agent:
      envelope.action === "fix"
        ? { status: "failed" as const, reason: "agent_activation_not_enabled" }
        : { status: "not_requested" as const },
  };
  const serialized = JSON.stringify(response);
  await c.env.LINEAR_KV.put(idempotencyStorageKey, serialized, {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
  return new Response(serialized, jsonInit(201));
}

async function createPreviewFeedbackIssue(
  env: Env,
  envelope: PreviewFeedbackEnvelope
): Promise<CreatedLinearIssue> {
  const organizationId = required(env.PREVIEW_FEEDBACK_ORGANIZATION_ID);
  const teamId = required(env.PREVIEW_FEEDBACK_TEAM_ID);
  const client = await getLinearClientOrThrow(env, organizationId);
  return createIssue(client, {
    teamId,
    title: issueTitle(envelope),
    description: issueDescription(envelope),
    ...(env.PREVIEW_FEEDBACK_PROJECT_ID ? { projectId: env.PREVIEW_FEEDBACK_PROJECT_ID } : {}),
  });
}

export function issueTitle(envelope: PreviewFeedbackEnvelope): string {
  const subject =
    envelope.selection.componentName ?? envelope.selection.testId ?? envelope.selection.tagName;
  const firstSentence = envelope.comment.split(/(?<=[.!?])\s/u)[0] ?? envelope.comment;
  return `[UI feedback] ${subject}: ${firstSentence}`.slice(0, 240);
}

export function issueDescription(envelope: PreviewFeedbackEnvelope): string {
  const source = envelope.selection.source;
  const sourceText = source
    ? `${source.file}${source.line ? `:${source.line}${source.column ? `:${source.column}` : ""}` : ""}`
    : "Unavailable in this build";
  const classes = formatClasses(envelope.selection.classNames);
  const ancestors = (envelope.selection.ancestors ?? [])
    .map((node, index) => `${index + 1}. ${formatDomNode(node)}`)
    .join("\n");
  const pr = envelope.deployment.prNumber === null ? "N/A" : `#${envelope.deployment.prNumber}`;
  return [
    "## Feedback",
    "",
    envelope.comment,
    "",
    "## Selected element",
    "",
    `- Component: \`${escapeInline(envelope.selection.componentName ?? "DOM context only")}\``,
    `- Element: \`${escapeInline(formatDomNode(envelope.selection))}\``,
    `- CSS classes: ${classes}`,
    `- Source: \`${escapeInline(sourceText)}\``,
    `- Route: \`${escapeInline(envelope.page.path)}\``,
    `- Accessible name: ${envelope.selection.accessibleName ?? "Unavailable"}`,
    ...(ancestors ? ["", "### DOM ancestors (nearest first)", "", ancestors] : []),
    "",
    "## Preview",
    "",
    `- URL: ${envelope.page.url}`,
    `- Repository: \`${escapeInline(envelope.deployment.repository)}\``,
    `- PR: ${pr}`,
    `- Branch: \`${escapeInline(envelope.deployment.branch)}\``,
    `- Commit: \`${escapeInline(envelope.deployment.commitSha)}\``,
    `- Reporter: ${envelope.reporter.displayName}`,
    "",
    `<!-- opsdna-preview-feedback:v1 feedbackId=${escapeInline(envelope.feedbackId)} -->`,
  ].join("\n");
}

function formatDomNode(node: PreviewFeedbackEnvelope["selection"]): string {
  const id = node.id ? `#${node.id}` : "";
  const classes = (node.classNames ?? []).map((name) => `.${name}`).join("");
  const testId = node.testId ? `[data-testid="${node.testId}"]` : "";
  return `${node.tagName}${id}${classes}${testId}`;
}

function formatClasses(classes: readonly string[] | undefined): string {
  return classes?.length ? classes.map((name) => `\`${escapeInline(name)}\``).join(", ") : "None";
}

function parseEnvelope(value: unknown): PreviewFeedbackEnvelope | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (value.action !== "track" && value.action !== "fix") return null;
  if (!isString(value.comment, 10, 4000) || !isUuidString(value.feedbackId)) return null;
  if (!isUuidString(value.idempotencyKey) || !isRecord(value.reporter)) return null;
  if (!isString(value.reporter.identityId, 1, 300) || !isString(value.reporter.displayName, 1, 300))
    return null;
  if (!isRecord(value.deployment) || !isRecord(value.page) || !isRecord(value.selection))
    return null;
  if (value.deployment.kind !== "feature_preview" && value.deployment.kind !== "staging")
    return null;
  if (!isString(value.deployment.repository, 1, 200) || !isString(value.deployment.branch, 1, 500))
    return null;
  if (
    !isString(value.deployment.commitSha, 1, 100) ||
    !isString(value.deployment.portalUrl, 1, 2000)
  )
    return null;
  if (!(value.deployment.prNumber === null || Number.isSafeInteger(value.deployment.prNumber)))
    return null;
  if (!isString(value.page.url, 1, 2000) || !isString(value.page.path, 1, 2000)) return null;
  if (!isString(value.selection.tagName, 1, 100)) return null;
  return value as unknown as PreviewFeedbackEnvelope;
}

function isAllowed(value: string, csv: string | undefined): boolean {
  if (!csv) return false;
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(value);
}

function isOriginAllowed(origin: string, csv: string | undefined): boolean {
  if (!csv) return false;
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((pattern) => {
      if (!pattern.includes("*")) return pattern === origin;
      if ((pattern.match(/\*/gu) ?? []).length !== 1) return false;
      const [prefix, suffix] = pattern.split("*") as [string, string];
      return origin.startsWith(prefix) && origin.endsWith(suffix);
    });
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function required(value: string | undefined): string {
  if (!value) throw new Error("Preview feedback Linear settings are incomplete");
  return value;
}

function escapeInline(value: string): string {
  return value.replaceAll("`", "\\`").replaceAll("\n", " ");
}

function reason(c: Context, status: number, value: string): Response {
  return c.json({ error: "Preview feedback request failed", reason: value }, status as 400);
}

function jsonInit(status: number): ResponseInit {
  return { status, headers: { "content-type": "application/json; charset=UTF-8" } };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
