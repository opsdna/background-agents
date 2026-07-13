import { describe, expect, it, vi } from "vitest";

import { resolveSessionTarget } from "./target-resolution";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("preview feedback target resolution", () => {
  it("uses trusted issue dispatch before normal Linear repository classification", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET = "dispatch-secret-at-least-thirty-two-bytes";
    const issueDescription = await signedMarker(env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET, {
      version: 1,
      issueId: "issue-id",
      profile: "research",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });

    await expect(
      resolveSessionTarget({
        env,
        client: { accessToken: "linear-token" },
        agentSessionId: "agent-session-id",
        issue: {
          id: "issue-id",
          identifier: "OPS-999",
          title: "Preview feedback",
          url: "https://linear.app/opsdna/issue/OPS-999",
          priority: 0,
          priorityLabel: "No priority",
          team: { id: "team-id", key: "OPS", name: "OpsDNA" },
        },
        labelNames: [],
        projectInfo: null,
        comment: null,
        traceId: "trace-id",
        issueDescription,
      })
    ).resolves.toEqual({
      target: {
        kind: "repository",
        owner: "opsdna",
        name: "opsdna",
        fullName: "opsdna/opsdna",
      },
      reasoning: "Trusted OpsDNA preview feedback dispatch",
      baseBranch: "codex/preview-feedback",
      previewFeedbackProfile: "research",
    });
    expect(vi.mocked(env.CONTROL_PLANE.fetch)).not.toHaveBeenCalled();
  });
});

async function signedMarker(secret: string, value: Record<string, unknown>): Promise<string> {
  const payload = btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = [
    ...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `<!-- opsdna-preview-dispatch:v1 payload=${payload} signature=${signature} -->`;
}
