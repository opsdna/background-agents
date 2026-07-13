import { describe, expect, it } from "vitest";

import {
  getPreviewFeedbackDispatch,
  previewFeedbackProfileInstructions,
  storePreviewFeedbackDispatch,
} from "./preview-feedback-dispatch";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("preview feedback dispatch", () => {
  it("round trips trusted issue dispatch metadata", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await storePreviewFeedbackDispatch(env, "issue-id", {
      profile: "implement",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });

    await expect(getPreviewFeedbackDispatch(env, "issue-id")).resolves.toEqual({
      profile: "implement",
      repository: "opsdna/opsdna",
      baseBranch: "codex/preview-feedback",
    });
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
});
