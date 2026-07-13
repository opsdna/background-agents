import { describe, expect, it, vi } from "vitest";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";
import { resolveSessionTarget, targetRequestFields } from "./target-resolution";
import type { AgentSessionWebhookIssue } from "./types";

const PARENT_ID = "linear-parent-id";
const CHANNEL_KEY = "linear-org:opsdna/opsdna:feature_preview:pr-1548";

function issue(): AgentSessionWebhookIssue {
  return {
    id: PARENT_ID,
    identifier: "OPS-1000",
    title: "[Preview PR #1548] UI feedback channel",
    url: "https://linear.app/opsdna/issue/OPS-1000",
    priority: 0,
    priorityLabel: "No priority",
    team: { id: "team-id", key: "OPS", name: "OpsDNA" },
  };
}

describe("preview feedback target resolution", () => {
  it("uses the trusted channel branch before ordinary issue classification", async () => {
    const { kv } = createFakeKV({ [`preview-feedback:parent:${PARENT_ID}`]: CHANNEL_KEY });
    const controlPlaneFetch = vi.fn().mockResolvedValue(
      Response.json({
        channel: {
          repository: "opsdna/opsdna",
          baseBranch: "codex/preview-feedback-react-grab-spike",
          status: "tracking",
        },
      })
    );
    const env = makeLinearBotEnv(kv, {
      INTERNAL_CALLBACK_SECRET: "internal-secret",
      CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
    });

    const result = await resolveSessionTarget({
      env,
      client: { accessToken: "linear-token" },
      agentSessionId: "agent-session-id",
      issue: issue(),
      labelNames: [],
      projectInfo: null,
      comment: null,
      traceId: "trace-id",
    });

    expect(result?.target).toMatchObject({
      kind: "repository",
      owner: "opsdna",
      name: "opsdna",
      baseBranch: "codex/preview-feedback-react-grab-spike",
    });
    expect(result && targetRequestFields(result.target)).toEqual({
      repoOwner: "opsdna",
      repoName: "opsdna",
      branch: "codex/preview-feedback-react-grab-spike",
    });
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
  });
});
