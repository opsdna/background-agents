import { describe, expect, it } from "vitest";

import {
  getPreviewFeedbackDispatch,
  previewFeedbackProfileInstructions,
  stripPreviewFeedbackMarkers,
} from "./preview-feedback-dispatch";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("preview feedback dispatch", () => {
  it("verifies trusted issue dispatch metadata", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET = "dispatch-secret-at-least-thirty-two-bytes";
    const description = await signedMarker(env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET, {
      version: 1,
      issueId: "issue-id",
      profile: "implement",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });

    await expect(getPreviewFeedbackDispatch(env, "issue-id", description)).resolves.toEqual({
      profile: "implement",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });
  });

  it("rejects a marker copied to another issue", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET = "dispatch-secret-at-least-thirty-two-bytes";
    const description = await signedMarker(env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET, {
      version: 1,
      issueId: "issue-id",
      profile: "research",
      repository: "opsdna/opsdna",
      baseBranch: "staging",
    });
    await expect(getPreviewFeedbackDispatch(env, "other-issue", description)).resolves.toBeNull();
  });

  it("keeps research read-only and makes implementation target explicit", () => {
    const research = previewFeedbackProfileInstructions({
      profile: "research",
      repository: "opsdna/opsdna",
      baseBranch: "staging",
    });
    expect(research).toContain("Do not modify files");
    expect(research).toContain("greenlight");

    const implement = previewFeedbackProfileInstructions({
      profile: "implement",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });
    expect(implement).toContain("open a draft pull request");
    expect(implement).toContain("must target codex/preview-feedback");
  });

  it("removes preview feedback and dispatch marker comments", () => {
    const text = [
      "Before",
      "<!-- opsdna-preview-feedback:v1 feedbackId=feedback-1 -->",
      "Middle",
      "<!-- opsdna-preview-dispatch:v1 payload=payload signature=signature -->",
      "After",
    ].join("\n");

    expect(stripPreviewFeedbackMarkers(text)).toBe("Before\n\nMiddle\n\nAfter");
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
