import { describe, expect, it, vi } from "vitest";

import { storePreviewFeedbackDispatch } from "./preview-feedback-dispatch";
import { resolveSessionTarget } from "./target-resolution";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("preview feedback target resolution", () => {
  it("uses trusted issue dispatch before normal Linear repository classification", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await storePreviewFeedbackDispatch(env, "issue-id", {
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
