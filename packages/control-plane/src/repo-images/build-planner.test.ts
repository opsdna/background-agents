import { describe, expect, it, vi } from "vitest";

import { RepoImageBuildPlanner } from "./build-planner";
import { resolveSandboxSettingsForRepos } from "../session/integration-settings-resolution";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
  resolveSandboxSettingsForRepos: vi.fn(),
}));

describe("RepoImageBuildPlanner", () => {
  it("throws when batch sandbox settings are not aligned with repos", async () => {
    vi.mocked(resolveSandboxSettingsForRepos).mockResolvedValueOnce([{ dockerEnabled: true }]);

    const planner = new RepoImageBuildPlanner({} as D1Database);

    await expect(
      planner.planMany([
        { repoOwner: "acme", repoName: "app" },
        { repoOwner: "acme", repoName: "api" },
      ])
    ).rejects.toThrow("resolveSandboxSettingsForRepos returned 1 settings for 2 repos");
  });
});
