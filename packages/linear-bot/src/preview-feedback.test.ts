import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeKV, makeLinearBotEnv } from "./test-helpers";
import type { Env } from "./types";
import {
  activatePreviewAgent,
  createPreviewFeedbackIssue,
  handlePreviewFeedbackIngest,
  issueDescription,
  issueTitle,
} from "./preview-feedback";

const SECRET = "preview-feedback-test-secret-at-least-thirty-two-bytes";
const NOW_MS = Date.parse("2026-07-13T16:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const NONCE = "2151ad88-256c-4fae-98e0-208622409a39";
const IDEMPOTENCY = "14620613-a657-421b-9165-30abc0b4d1d3";
const ORIGIN = "https://opsdna-portal-pr-1548.example.workers.dev";

afterEach(() => vi.unstubAllGlobals());

function payload() {
  return {
    schemaVersion: 1,
    action: "track",
    comment: "Increase the spacing around this card.",
    feedbackId: "b94f1c20-b3af-41ca-948e-c8a8c2f47678",
    idempotencyKey: IDEMPOTENCY,
    submittedAt: "2026-07-13T16:00:00.000Z",
    reporter: { identityId: "identity:evan", displayName: "Evan Rosenfeld" },
    deployment: {
      kind: "feature_preview",
      repository: "opsdna/opsdna",
      prNumber: 1548,
      branch: "codex/preview-feedback-react-grab-spike",
      commitSha: "a".repeat(40),
      portalUrl: ORIGIN,
    },
    page: { url: `${ORIGIN}/funds/fund_demo`, path: "/funds/fund_demo" },
    selection: {
      componentName: "FundGpCard",
      source: { file: "apps/portal/src/fund-gp-card.tsx", line: 16 },
      tagName: "div",
      id: "gp-card",
      testId: "fund-gp-card",
      classNames: ["grid", "gap-4", "border"],
      ancestors: [
        { tagName: "section", classNames: ["space-y-6", "px-5"] },
        { tagName: "main", id: "fund-main", classNames: ["min-w-0"] },
      ],
      accessibleName: "General partner not set up",
      boundingRect: { x: 301, y: 299, width: 1026, height: 66 },
    },
  } as const;
}

function app(
  createLinearIssue = vi.fn(async () => ({
    id: "issue-id",
    identifier: "OPS-999",
    url: "https://linear.app/opsdna/issue/OPS-999",
  })),
  activateAgent?: () => Promise<{ status: "started"; sessionUrl: string }>
) {
  const instance = new Hono<{ Bindings: Env }>();
  instance.post("/preview-feedback/ingest", (c) =>
    handlePreviewFeedbackIngest(c, {
      now: () => NOW_MS,
      createLinearIssue,
      ...(activateAgent ? { activateAgent } : {}),
    })
  );
  return { instance, createLinearIssue };
}

function env(kv: KVNamespace): Env {
  return makeLinearBotEnv(kv, {
    PREVIEW_FEEDBACK_HMAC_SECRET: SECRET,
    PREVIEW_FEEDBACK_ORGANIZATION_ID: "linear-org",
    PREVIEW_FEEDBACK_TEAM_ID: "linear-team",
    PREVIEW_FEEDBACK_ALLOWED_REPOSITORIES: "opsdna/opsdna",
    PREVIEW_FEEDBACK_ALLOWED_PORTAL_ORIGINS: ORIGIN,
  });
}

async function signedRequest(
  body: string,
  overrides: Record<string, string> = {},
  requestIds: { nonce?: string; idempotencyKey?: string } = {}
): Promise<Request> {
  const requestNonce = requestIds.nonce ?? NONCE;
  const requestIdempotencyKey = requestIds.idempotencyKey ?? IDEMPOTENCY;
  const bodyHash = await sha256(body);
  const signature = await hmac(`v1\n${TIMESTAMP}\n${requestNonce}\n${bodyHash}`);
  return new Request("https://linear-bot.example/preview-feedback/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": requestIdempotencyKey,
      "x-opsdna-feedback-timestamp": TIMESTAMP,
      "x-opsdna-feedback-nonce": requestNonce,
      "x-opsdna-feedback-signature": `v1=${signature}`,
      ...overrides,
    },
    body,
  });
}

describe("POST /preview-feedback/ingest", () => {
  it("creates a Linear issue and stores a retry-safe response", async () => {
    const { kv, putCalls } = createFakeKV();
    const { instance, createLinearIssue } = app();
    const body = JSON.stringify(payload());
    const response = await instance.fetch(await signedRequest(body), env(kv));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      feedbackId: payload().feedbackId,
      linearIssue: {
        id: "issue-id",
        identifier: "OPS-999",
        url: "https://linear.app/opsdna/issue/OPS-999",
      },
      agent: { status: "not_requested" },
    });
    expect(createLinearIssue).toHaveBeenCalledOnce();
    expect(putCalls.map((call) => call.key)).toEqual(
      expect.arrayContaining([
        `preview-feedback:nonce:${NONCE}`,
        `preview-feedback:idempotency:${IDEMPOTENCY}`,
      ])
    );
    expect(putCalls.filter((call) => call.key.includes(":rate:"))).toHaveLength(2);
  });

  it("returns the stored response without creating a duplicate issue", async () => {
    const stored = JSON.stringify({
      feedbackId: payload().feedbackId,
      linearIssue: { id: "issue-id", identifier: "OPS-999", url: "https://linear.app/x" },
      agent: { status: "not_requested" },
    });
    const { kv } = createFakeKV({
      [`preview-feedback:idempotency:${IDEMPOTENCY}`]: stored,
    });
    const { instance, createLinearIssue } = app();
    const response = await instance.fetch(await signedRequest(JSON.stringify(payload())), env(kv));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(stored);
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it("rejects a modified body and disallowed repository", async () => {
    const { kv } = createFakeKV();
    const { instance, createLinearIssue } = app();
    const original = JSON.stringify(payload());
    const modified = original.replace("opsdna/opsdna", "attacker/repository");
    const badSignature = await instance.fetch(
      await signedRequest(original, {
        "x-opsdna-feedback-signature": "v1=deadbeef",
      }),
      env(kv)
    );
    expect(badSignature.status).toBe(401);

    const disallowed = await instance.fetch(await signedRequest(modified), env(kv));
    expect(disallowed.status).toBe(403);
    expect(await disallowed.json()).toMatchObject({ reason: "repository_not_allowed" });
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it("rate limits a reporter before creating another issue", async () => {
    const { kv } = createFakeKV();
    const { instance, createLinearIssue } = app();
    const configured = env(kv);
    configured.PREVIEW_FEEDBACK_REPORTER_LIMIT_PER_HOUR = "1";
    await instance.fetch(await signedRequest(JSON.stringify(payload())), configured);

    const nextIdempotencyKey = "9f2998e3-705b-4e1c-bfad-6200b910d2bd";
    const nextNonce = "8c95a7cd-3881-4e93-a3ef-1865bea533ed";
    const nextPayload = {
      ...payload(),
      feedbackId: "56fb4fba-8176-4dea-9949-da74d719b59e",
      idempotencyKey: nextIdempotencyKey,
    };
    const response = await instance.fetch(
      await signedRequest(
        JSON.stringify(nextPayload),
        {},
        {
          nonce: nextNonce,
          idempotencyKey: nextIdempotencyKey,
        }
      ),
      configured
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toMatchObject({ reason: "reporter_rate_limited" });
    expect(createLinearIssue).toHaveBeenCalledOnce();
  });

  it("rejects malformed nested DOM and screenshot data", async () => {
    const { kv } = createFakeKV();
    const { instance, createLinearIssue } = app();
    const malformed = {
      ...payload(),
      selection: { ...payload().selection, classNames: ["valid", 42] },
      screenshot: { mimeType: "image/svg+xml", base64: "PHN2Zz4=", width: 10, height: 10 },
    };
    const response = await instance.fetch(await signedRequest(JSON.stringify(malformed)), env(kv));
    expect(response.status).toBe(400);
    expect(createLinearIssue).not.toHaveBeenCalled();
  });

  it("returns the proactive session result for fix requests", async () => {
    const { kv } = createFakeKV();
    const activateAgent = vi.fn(async () => ({
      status: "started" as const,
      sessionUrl: "https://linear.app/agent/session",
    }));
    const { instance } = app(undefined, activateAgent);
    const fixPayload = { ...payload(), action: "fix" as const };
    const response = await instance.fetch(await signedRequest(JSON.stringify(fixPayload)), env(kv));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      agent: { status: "started", sessionUrl: "https://linear.app/agent/session" },
    });
    expect(activateAgent).toHaveBeenCalledOnce();
  });
});

describe("preview feedback Linear formatting", () => {
  it("includes source, selected classes, and nearest DOM ancestors", () => {
    const envelope = payload();
    expect(issueTitle(envelope)).toBe(
      "[UI feedback] FundGpCard: Increase the spacing around this card."
    );
    const description = issueDescription(envelope);
    expect(description).toContain("CSS classes: `grid`, `gap-4`, `border`");
    expect(description).toContain('div#gp-card.grid.gap-4.border[data-testid="fund-gp-card"]');
    expect(description).toContain("section.space-y-6.px-5");
    expect(description).toContain("main#fund-main.min-w-0");
    expect(description).toContain("apps/portal/src/fund-gp-card.tsx:16");
  });
});

describe("preview feedback parent channel", () => {
  it("registers one parent issue and creates feedback as its child", async () => {
    const { kv } = createFakeKV({
      "oauth:token:linear-org": JSON.stringify({
        access_token: "linear-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 10 * 60 * 1000,
      }),
    });
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          claimed: true,
          channel: { parentLinearIssueId: null, parentLinearIssueIdentifier: null },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
          },
        })
      );
    const configured = env(kv);
    configured.CONTROL_PLANE = { fetch: controlPlaneFetch } as unknown as Fetcher;
    configured.INTERNAL_CALLBACK_SECRET = "internal-callback-secret";

    const linearFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "parent-id",
                identifier: "OPS-1000",
                url: "https://linear.app/opsdna/issue/OPS-1000",
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "child-id",
                identifier: "OPS-1001",
                url: "https://linear.app/opsdna/issue/OPS-1001",
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ data: { attachmentCreate: { success: true } } }));
    vi.stubGlobal("fetch", linearFetch);

    await expect(createPreviewFeedbackIssue(configured, payload())).resolves.toMatchObject({
      id: "child-id",
    });
    const parentInput = JSON.parse(String(linearFetch.mock.calls[0]![1]?.body)).variables.input;
    const childInput = JSON.parse(String(linearFetch.mock.calls[1]![1]?.body)).variables.input;
    expect(parentInput.title).toBe("[Preview PR #1548] UI feedback channel");
    expect(childInput.parentId).toBe("parent-id");
    expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
  });
});

describe("preview feedback agent reuse", () => {
  it("verifies the live base before creating the first Linear Agent Session", async () => {
    const { kv } = createFakeKV({
      "oauth:token:linear-org": JSON.stringify({
        access_token: "linear-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 10 * 60 * 1000,
      }),
    });
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          claimed: true,
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
            baseSha: "c".repeat(40),
            sessionSyncedSha: null,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            parentLinearIssueId: "parent-id",
            linearAgentSessionId: "linear-agent-session",
          },
        })
      );
    const linearFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true } } }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            agentSessionCreateOnIssue: {
              success: true,
              agentSession: {
                id: "linear-agent-session",
                url: "https://linear.app/agent/session",
                status: "pending",
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true } } }));
    vi.stubGlobal("fetch", linearFetch);
    const configured = env(kv);
    configured.INTERNAL_CALLBACK_SECRET = "internal-secret";
    configured.CONTROL_PLANE = { fetch: controlPlaneFetch } as unknown as Fetcher;

    await expect(
      activatePreviewAgent(
        configured,
        { ...payload(), action: "fix" },
        {
          id: "child-id",
          identifier: "OPS-1001",
          url: "https://linear.app/opsdna/issue/OPS-1001",
        }
      )
    ).resolves.toEqual({
      status: "started",
      sessionUrl: "https://linear.app/agent/session",
    });
    expect(controlPlaneFetch.mock.calls[1]![0]).toBe(
      "https://internal/preview-feedback/channels/resolve-base"
    );
    const comment = JSON.parse(String(linearFetch.mock.calls[0]![1]?.body)).variables.input.body;
    expect(comment).toContain(`GitHub-verified base commit: ${"c".repeat(40)}`);
    expect(comment).toContain("OPS-1001");
    const childComment = JSON.parse(String(linearFetch.mock.calls[2]![1]?.body)).variables.input;
    expect(childComment).toEqual({
      issueId: "child-id",
      body: "Open Inspect agent session started: https://linear.app/agent/session",
    });
  });

  it("queues later feedback into the registered Open Inspect session", async () => {
    const { kv } = createFakeKV({
      "oauth:token:linear-org": JSON.stringify({
        access_token: "linear-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 10 * 60 * 1000,
      }),
    });
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          claimed: true,
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
            linearAgentSessionId: "linear-agent-session",
            openInspectSessionId: "open-inspect-session",
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
            linearAgentSessionId: "linear-agent-session",
            openInspectSessionId: "open-inspect-session",
            baseSha: "b".repeat(40),
            sessionSyncedSha: "a".repeat(40),
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ status: "active" }))
      .mockResolvedValueOnce(Response.json({ accepted: true }))
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            parentLinearIssueId: "parent-id",
            parentLinearIssueIdentifier: "OPS-1000",
          },
        })
      );
    const configured = env(kv);
    configured.INTERNAL_CALLBACK_SECRET = "internal-secret";
    configured.CONTROL_PLANE = { fetch: controlPlaneFetch } as unknown as Fetcher;
    const linearFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true } } }));
    vi.stubGlobal("fetch", linearFetch);

    await expect(
      activatePreviewAgent(
        configured,
        { ...payload(), action: "fix" },
        {
          id: "child-id",
          identifier: "OPS-1001",
          url: "https://linear.app/opsdna/issue/OPS-1001",
        }
      )
    ).resolves.toEqual({
      status: "queued",
      sessionUrl: "https://web.example.test/session/open-inspect-session",
    });
    const promptRequest = controlPlaneFetch.mock.calls[3]![1] as RequestInit;
    const prompt = JSON.parse(String(promptRequest.body));
    expect(prompt.source).toBe("linear-preview-feedback");
    expect(prompt.content).toContain("<untrusted-preview-feedback>");
    expect(prompt.content).toContain("Increase the spacing around this card.");
    expect(prompt.content).toContain(`GitHub-verified base commit: ${"b".repeat(40)}`);
    expect(prompt.content).toContain("merge origin/codex/preview-feedback-react-grab-spike");
    expect(JSON.parse(String(linearFetch.mock.calls[0]![1]?.body)).variables.input).toEqual({
      issueId: "child-id",
      body: "Added to the active Open Inspect session: https://web.example.test/session/open-inspect-session",
    });
  });

  it("waits for a concurrent activation and then queues into its attached session", async () => {
    const { kv } = createFakeKV({
      "oauth:token:linear-org": JSON.stringify({
        access_token: "linear-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 10 * 60 * 1000,
      }),
    });
    const provisioningChannel = {
      parentLinearIssueId: "parent-id",
      parentLinearIssueIdentifier: "OPS-1000",
      linearAgentSessionId: "linear-agent-session",
      openInspectSessionId: null,
    };
    const attachedChannel = {
      ...provisioningChannel,
      openInspectSessionId: "open-inspect-session",
    };
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ claimed: false, channel: provisioningChannel }, { status: 409 })
      )
      .mockResolvedValueOnce(Response.json({ channel: attachedChannel }))
      .mockResolvedValueOnce(Response.json({ claimed: true, channel: attachedChannel }))
      .mockResolvedValueOnce(
        Response.json({
          channel: {
            ...attachedChannel,
            baseSha: "b".repeat(40),
            sessionSyncedSha: "b".repeat(40),
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ status: "active" }))
      .mockResolvedValueOnce(Response.json({ accepted: true }))
      .mockResolvedValueOnce(Response.json({ channel: attachedChannel }));
    const configured = env(kv);
    configured.INTERNAL_CALLBACK_SECRET = "internal-secret";
    configured.CONTROL_PLANE = { fetch: controlPlaneFetch } as unknown as Fetcher;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { commentCreate: { success: true } } }))
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      activatePreviewAgent(
        configured,
        { ...payload(), action: "fix" },
        {
          id: "child-id",
          identifier: "OPS-1002",
          url: "https://linear.app/opsdna/issue/OPS-1002",
        },
        { sleep }
      )
    ).resolves.toEqual({
      status: "queued",
      sessionUrl: "https://web.example.test/session/open-inspect-session",
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(controlPlaneFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://internal/preview-feedback/channels/claim",
      "https://internal/preview-feedback/channels/get",
      "https://internal/preview-feedback/channels/claim",
      "https://internal/preview-feedback/channels/resolve-base",
      "https://internal/sessions/open-inspect-session",
      "https://internal/sessions/open-inspect-session/prompt",
      "https://internal/preview-feedback/channels/update",
    ]);
  });

  it("replaces an archived session before handling new feedback", async () => {
    const { kv } = createFakeKV({
      "oauth:token:linear-org": JSON.stringify({
        access_token: "linear-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 10 * 60 * 1000,
      }),
    });
    const staleChannel = {
      parentLinearIssueId: "parent-id",
      parentLinearIssueIdentifier: "OPS-1000",
      linearAgentSessionId: "stale-linear-session",
      openInspectSessionId: "stale-open-inspect-session",
    };
    const resetChannel = {
      ...staleChannel,
      linearAgentSessionId: null,
      openInspectSessionId: null,
      sessionSyncedSha: null,
    };
    const controlPlaneFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ claimed: true, channel: staleChannel }))
      .mockResolvedValueOnce(
        Response.json({ channel: { ...staleChannel, baseSha: "c".repeat(40) } })
      )
      .mockResolvedValueOnce(Response.json({ status: "archived" }))
      .mockResolvedValueOnce(Response.json({ channel: resetChannel }))
      .mockResolvedValueOnce(
        Response.json({
          channel: { ...resetChannel, linearAgentSessionId: "replacement-linear-session" },
        })
      );
    const linearFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true } } }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            agentSessionCreateOnIssue: {
              success: true,
              agentSession: {
                id: "replacement-linear-session",
                url: "https://linear.app/agent/replacement",
                status: "pending",
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ data: { commentCreate: { success: true } } }));
    vi.stubGlobal("fetch", linearFetch);
    const configured = env(kv);
    configured.INTERNAL_CALLBACK_SECRET = "internal-secret";
    configured.CONTROL_PLANE = { fetch: controlPlaneFetch } as unknown as Fetcher;

    await expect(
      activatePreviewAgent(
        configured,
        { ...payload(), action: "fix" },
        {
          id: "child-id",
          identifier: "OPS-1003",
          url: "https://linear.app/opsdna/issue/OPS-1003",
        }
      )
    ).resolves.toEqual({
      status: "started",
      sessionUrl: "https://linear.app/agent/replacement",
    });
    expect(controlPlaneFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://internal/preview-feedback/channels/claim",
      "https://internal/preview-feedback/channels/resolve-base",
      "https://internal/sessions/stale-open-inspect-session",
      "https://internal/preview-feedback/channels/reset-session",
      "https://internal/preview-feedback/channels/update",
    ]);
  });
});

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(hex).join("");
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
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))]
    .map(hex)
    .join("");
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
