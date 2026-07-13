import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { handlePreviewFeedbackClose } from "./preview-feedback-close";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";
import type { Env } from "./types";

const SECRET = "preview-feedback-test-secret-at-least-thirty-two-bytes";
const NOW_MS = Date.parse("2026-07-13T16:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const NONCE = "2151ad88-256c-4fae-98e0-208622409a39";
const IDEMPOTENCY_KEY = "14620613-a657-421b-9165-30abc0b4d1d3";

function payload() {
  return {
    schemaVersion: 1,
    repository: "opsdna/opsdna",
    deploymentKind: "feature_preview",
    previewId: "pr-1548",
    prNumber: 1548,
    branch: "codex/preview-feedback-react-grab-spike",
    closedAt: "2026-07-13T16:00:00.000Z",
    reason: "pull_request_closed",
  } as const;
}

function app() {
  const instance = new Hono<{ Bindings: Env }>();
  instance.post("/preview-feedback/close", (c) =>
    handlePreviewFeedbackClose(c, { now: () => NOW_MS })
  );
  return instance;
}

function configuredEnv(kv: KVNamespace, controlPlaneFetch = vi.fn()): Env {
  return makeLinearBotEnv(kv, {
    PREVIEW_FEEDBACK_HMAC_SECRET: SECRET,
    PREVIEW_FEEDBACK_ORGANIZATION_ID: "linear-org",
    PREVIEW_FEEDBACK_ALLOWED_REPOSITORIES: "opsdna/opsdna",
    CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
  });
}

async function signedRequest(body: string, nonce = NONCE): Promise<Request> {
  const bodyHash = await digest(body);
  const signature = await hmac(`v1\n${TIMESTAMP}\n${nonce}\n${bodyHash}`);
  return new Request("https://linear-bot.example/preview-feedback/close", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": IDEMPOTENCY_KEY,
      "x-opsdna-feedback-timestamp": TIMESTAMP,
      "x-opsdna-feedback-nonce": nonce,
      "x-opsdna-feedback-signature": `v1=${signature}`,
    },
    body,
  });
}

describe("POST /preview-feedback/close", () => {
  it("closes the exact channel through the control plane", async () => {
    const { kv } = createFakeKV();
    const controlPlaneFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ closed: true, sessionCleanup: "cancelled" })
    );
    const response = await app().fetch(
      await signedRequest(JSON.stringify(payload())),
      configuredEnv(kv, controlPlaneFetch)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, sessionCleanup: "cancelled" });
    const [, init] = controlPlaneFetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      channelKey: "linear-org:opsdna/opsdna:feature_preview:pr-1548",
      repository: "opsdna/opsdna",
      deploymentKind: "feature_preview",
      previewId: "pr-1548",
      prNumber: 1548,
      baseBranch: "codex/preview-feedback-react-grab-spike",
      now: NOW_MS,
    });
  });

  it("rejects mismatched preview identity and disallowed repositories", async () => {
    const { kv } = createFakeKV();
    const controlPlaneFetch = vi.fn();
    const mismatch = { ...payload(), previewId: "pr-99" };
    const mismatchResponse = await app().fetch(
      await signedRequest(JSON.stringify(mismatch)),
      configuredEnv(kv, controlPlaneFetch)
    );
    expect(mismatchResponse.status).toBe(400);

    const disallowed = { ...payload(), repository: "attacker/repository" };
    const disallowedResponse = await app().fetch(
      await signedRequest(JSON.stringify(disallowed), "8c95a7cd-3881-4e93-a3ef-1865bea533ed"),
      configuredEnv(kv, controlPlaneFetch)
    );
    expect(disallowedResponse.status).toBe(403);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(bytes));
}

async function hmac(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
