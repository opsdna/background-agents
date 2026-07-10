import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionResourceStore } from "../../src/db/session-resources";
import { cleanD1Tables } from "./cleanup";

describe("SessionResourceStore Neon lifecycle ownership", () => {
  beforeEach(cleanD1Tables);

  it("transfers a session branch to its PR and protects it from session cleanup", async () => {
    const store = new SessionResourceStore(env.DB);
    await store.upsertNeonBranch({
      sessionId: "public-session-1",
      repoOwner: "OpsDNA",
      repoName: "API",
      branchId: "br-session-1",
      branchName: "open-inspect-session-1",
      metadata: {
        projectId: "project-1",
        gitBranch: "open-inspect/session-1",
      },
      now: 100,
    });

    const transferred = await store.markNeonBranchOwnedByPullRequest({
      sessionId: "public-session-1",
      gitBranch: "open-inspect/session-1",
      prNumber: 123,
      prUrl: "https://github.com/opsdna/opsdna/pull/123",
      repoOwner: "OpsDNA",
      repoName: "API",
      now: 200,
    });
    expect(transferred).toBe(1);

    const row = await env.DB.prepare(
      "SELECT status, delete_after, metadata FROM session_resources WHERE resource_id = ?"
    )
      .bind("br-session-1")
      .first<{ status: string; delete_after: number | null; metadata: string }>();
    expect(row?.status).toBe("active");
    expect(row?.delete_after).toBeNull();
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      lifecycleOwner: "github_pr",
      gitBranch: "open-inspect/session-1",
      prNumber: 123,
    });

    expect(await store.markSessionForDeletion("public-session-1", 300, "completed", 250)).toBe(0);
    const due = await store.listDueForDeletion(301);
    expect(due).toHaveLength(0);
  });

  it("preserves PR ownership when a later sandbox spawn upserts the branch", async () => {
    const store = new SessionResourceStore(env.DB);
    await store.upsertNeonBranch({
      sessionId: "public-session-2",
      repoOwner: "acme",
      repoName: "web",
      branchId: "br-session-2",
      branchName: "open-inspect-session-2",
      metadata: { projectId: "project-1", gitBranch: "open-inspect/session-2" },
      now: 100,
    });
    await store.markNeonBranchOwnedByPullRequest({
      sessionId: "public-session-2",
      gitBranch: "open-inspect/session-2",
      prNumber: 456,
      prUrl: "https://github.com/acme/web/pull/456",
      repoOwner: "acme",
      repoName: "web",
      now: 200,
    });

    await store.upsertNeonBranch({
      sessionId: "public-session-2",
      repoOwner: "acme",
      repoName: "web",
      branchId: "br-session-2",
      branchName: "open-inspect-session-2",
      metadata: { projectId: "project-1", gitBranch: "open-inspect/session-2" },
      now: 300,
    });

    const row = await env.DB.prepare("SELECT metadata FROM session_resources WHERE resource_id = ?")
      .bind("br-session-2")
      .first<{ metadata: string }>();
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      lifecycleOwner: "github_pr",
      prNumber: 456,
      prUrl: "https://github.com/acme/web/pull/456",
    });
  });
});
