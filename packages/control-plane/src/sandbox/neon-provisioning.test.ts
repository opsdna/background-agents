import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../session/types";
import {
  buildNeonBranchName,
  deleteNeonBranch,
  hasNeonProvisioningConfig,
  provisionNeonDatabaseEnv,
  readNeonProvisioningConfig,
  stripNeonControlConfig,
} from "./neon-provisioning";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-123",
    session_name: "session-123",
    title: "Test",
    repo_owner: "Acme Org",
    repo_name: "OpsDNA API",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "openai/gpt-5.5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createNeonSecrets(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NEON_API_KEY: "neon-api-key",
    NEON_PROJECT_ID: "project-123",
    NEON_PARENT_BRANCH_ID: "br-parent",
    NEON_DATABASE_NAME: "opsdna",
    NEON_ROLE_NAME: "opsdna_owner",
    ...overrides,
  };
}

describe("neon provisioning", () => {
  it("detects and strips control-plane Neon config", () => {
    const env = {
      NEON_API_KEY: "secret",
      NEON_PROJECT_ID: "project-123",
      OPENAI_OAUTH_ACCESS_TOKEN: "token",
    };

    expect(hasNeonProvisioningConfig(env)).toBe(true);
    expect(stripNeonControlConfig(env)).toEqual({
      OPENAI_OAUTH_ACCESS_TOKEN: "token",
    });
  });

  it("fails fast when partial Neon config is present", () => {
    expect(() => readNeonProvisioningConfig({ NEON_API_KEY: "secret" })).toThrow(/NEON_PROJECT_ID/);
  });

  it("builds a deterministic sanitized branch name", () => {
    expect(buildNeonBranchName(createSession())).toBe(
      "open-inspect-acme-org-opsdna-api-session-123"
    );
  });

  it("reuses an existing branch and returns sandbox database env", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.includes("/branches?")) {
        return Response.json({
          branches: [
            {
              id: "br-existing",
              name: "open-inspect-acme-org-opsdna-api-session-123",
            },
          ],
        });
      }
      if (href.includes("/connection_uri?")) {
        return Response.json({ uri: "postgresql://owner:pw@example.test/opsdna?sslmode=require" });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });

    const result = await provisionNeonDatabaseEnv(createNeonSecrets(), createSession(), {
      fetchFn,
    });

    expect(result?.branchId).toBe("br-existing");
    expect(result?.projectId).toBe("project-123");
    expect(result?.env).toMatchObject({
      DATABASE_URL: "postgresql://owner:pw@example.test/opsdna?sslmode=require",
      OPSDNA_TEST_PG_DATABASE_URL: "postgresql://owner:pw@example.test/opsdna?sslmode=require",
      DEV_DATABASE_BACKEND: "postgres",
      OPEN_INSPECT_NEON_BRANCH_ID: "br-existing",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("creates a branch with a read-write endpoint when no branch exists", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      if (href.includes("/branches?")) {
        return Response.json({ branches: [] });
      }
      if (href.endsWith("/projects/project-123/branches")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer neon-api-key");
        expect(JSON.parse(String(init?.body))).toEqual({
          branch: {
            name: "open-inspect-acme-org-opsdna-api-session-123",
            parent_id: "br-parent",
          },
          endpoints: [{ type: "read_write" }],
        });
        return Response.json(
          {
            branch: {
              id: "br-created",
              name: "open-inspect-acme-org-opsdna-api-session-123",
            },
            operations: [{ id: "operation-1", status: "running" }],
          },
          { status: 201 }
        );
      }
      if (href.endsWith("/projects/project-123/operations/operation-1")) {
        return Response.json({ operation: { id: "operation-1", status: "finished" } });
      }
      if (href.includes("/connection_uri?")) {
        return Response.json({ uri: "postgresql://owner:pw@example.test/opsdna?sslmode=require" });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });

    const result = await provisionNeonDatabaseEnv(createNeonSecrets(), createSession(), {
      fetchFn,
      sleep: async () => undefined,
    });

    expect(result?.branchId).toBe("br-created");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("binds the default fetch receiver for Cloudflare Workers", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", async function (this: unknown, url: RequestInfo | URL) {
      receivers.push(this);
      const href = String(url);
      if (href.includes("/branches?")) {
        return Response.json({
          branches: [
            {
              id: "br-existing",
              name: "open-inspect-acme-org-opsdna-api-session-123",
            },
          ],
        });
      }
      if (href.includes("/connection_uri?")) {
        return Response.json({
          uri: "postgresql://owner:pw@example.test/opsdna?sslmode=require",
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    } as typeof fetch);

    try {
      await provisionNeonDatabaseEnv(createNeonSecrets(), createSession());
    } finally {
      vi.unstubAllGlobals();
    }

    expect(receivers).toEqual([globalThis, globalThis]);
  });

  it("resolves a configured parent branch name before creating a branch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      if (href.includes("/branches?search=open-inspect-acme-org-opsdna-api-session-123")) {
        return Response.json({ branches: [] });
      }
      if (href.includes("/branches?search=production")) {
        return Response.json({
          branches: [{ id: "br-production", name: "production" }],
        });
      }
      if (href.endsWith("/projects/project-123/branches")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          branch: {
            name: "open-inspect-acme-org-opsdna-api-session-123",
            parent_id: "br-production",
          },
        });
        return Response.json({
          branch: {
            id: "br-created",
            name: "open-inspect-acme-org-opsdna-api-session-123",
          },
        });
      }
      if (href.includes("/connection_uri?")) {
        return Response.json({ uri: "postgresql://owner:pw@example.test/opsdna?sslmode=require" });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });

    const result = await provisionNeonDatabaseEnv(
      createNeonSecrets({ NEON_PARENT_BRANCH_ID: "production" }),
      createSession(),
      { fetchFn }
    );

    expect(result?.branchId).toBe("br-created");
  });

  it("extracts a configured parent branch id from a Neon branch URL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      if (href.includes("/branches?")) {
        return Response.json({ branches: [] });
      }
      if (href.endsWith("/projects/project-123/branches")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          branch: {
            parent_id: "br-production",
          },
        });
        return Response.json({
          branch: {
            id: "br-created",
            name: "open-inspect-acme-org-opsdna-api-session-123",
          },
        });
      }
      if (href.includes("/connection_uri?")) {
        return Response.json({ uri: "postgresql://owner:pw@example.test/opsdna?sslmode=require" });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });

    const result = await provisionNeonDatabaseEnv(
      createNeonSecrets({
        NEON_PARENT_BRANCH_ID:
          "https://console.neon.tech/app/projects/project-123/branches/br-production",
      }),
      createSession(),
      { fetchFn }
    );

    expect(result?.branchId).toBe("br-created");
  });

  it("deletes a branch through the Neon API without hard-delete by default", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://console.neon.tech/api/v2/projects/project-123/branches/br-old?hard_delete=false"
      );
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer neon-api-key");
      return new Response(null, { status: 204 });
    });

    const config = readNeonProvisioningConfig(createNeonSecrets());
    expect(config).not.toBeNull();
    await deleteNeonBranch(config!, "br-old", { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
