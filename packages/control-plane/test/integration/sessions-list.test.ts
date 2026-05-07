import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

interface ListSessionsBody {
  sessions: Array<{ id: string; userId?: string | null; scmLogin?: string | null }>;
  total: number;
  hasMore: boolean;
}

describe("GET /sessions filter by current user", () => {
  beforeEach(cleanD1Tables);

  async function seedSession(
    store: SessionIndexStore,
    input: {
      id: string;
      userId?: string | null;
      scmLogin?: string | null;
      status?: "created" | "active" | "completed" | "archived";
      updatedAt?: number;
    }
  ): Promise<void> {
    const now = input.updatedAt ?? Date.now();
    await store.create({
      id: input.id,
      title: input.id,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: input.status ?? "active",
      userId: input.userId ?? null,
      scmLogin: input.scmLogin ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("filters by mineScmUserId+mineProvider, returning only that user's sessions", async () => {
    const store = new SessionIndexStore(env.DB);
    const userStore = new UserStore(env.DB);

    const alice = await userStore.resolveOrCreateUser({
      provider: "github",
      providerUserId: "12345",
      providerLogin: "alice",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
    const bob = await userStore.resolveOrCreateUser({
      provider: "github",
      providerUserId: "67890",
      providerLogin: "bob",
    });

    await seedSession(store, { id: "alice-1", userId: alice.id, updatedAt: 3000 });
    await seedSession(store, { id: "alice-2", userId: alice.id, updatedAt: 2000 });
    await seedSession(store, { id: "bob-1", userId: bob.id, updatedAt: 1000 });
    // Pre-migration session: scmLogin matches but user_id is null — must NOT appear
    await seedSession(store, { id: "pre-mig", scmLogin: "alice", updatedAt: 500 });

    const response = await SELF.fetch(
      "https://test.local/sessions?mineScmUserId=12345&mineProvider=github",
      { headers: await authHeaders() }
    );
    expect(response.status).toBe(200);
    const body = await response.json<ListSessionsBody>();
    expect(body.sessions.map((s) => s.id)).toEqual(["alice-1", "alice-2"]);
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  it("returns empty page when the provider identity is not yet canonicalized (spec E2)", async () => {
    const store = new SessionIndexStore(env.DB);
    await seedSession(store, { id: "any-1", userId: "u-someone", updatedAt: 1000 });

    const response = await SELF.fetch(
      "https://test.local/sessions?mineScmUserId=99999&mineProvider=github",
      { headers: await authHeaders() }
    );
    expect(response.status).toBe(200);
    const body = await response.json<ListSessionsBody>();
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("returns all sessions when no mineScmUserId is supplied (no regression)", async () => {
    const store = new SessionIndexStore(env.DB);
    await seedSession(store, { id: "s1", updatedAt: 2000 });
    await seedSession(store, { id: "s2", userId: "u-1", updatedAt: 1000 });

    const response = await SELF.fetch("https://test.local/sessions", {
      headers: await authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = await response.json<ListSessionsBody>();
    expect(body.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(body.total).toBe(2);
  });

  it("rejects unsupported mineProvider values", async () => {
    const response = await SELF.fetch(
      "https://test.local/sessions?mineScmUserId=12345&mineProvider=facebook",
      { headers: await authHeaders() }
    );
    expect(response.status).toBe(400);
  });

  it("rejects mineProvider without mineScmUserId", async () => {
    const response = await SELF.fetch("https://test.local/sessions?mineProvider=github", {
      headers: await authHeaders(),
    });
    expect(response.status).toBe(400);
  });

  it("combines mine filter with excludeStatus", async () => {
    const store = new SessionIndexStore(env.DB);
    const userStore = new UserStore(env.DB);

    const alice = await userStore.resolveOrCreateUser({
      provider: "github",
      providerUserId: "12345",
      providerLogin: "alice",
    });

    await seedSession(store, {
      id: "alice-active",
      userId: alice.id,
      status: "active",
      updatedAt: 3000,
    });
    await seedSession(store, {
      id: "alice-archived",
      userId: alice.id,
      status: "archived",
      updatedAt: 2000,
    });

    const response = await SELF.fetch(
      "https://test.local/sessions?mineScmUserId=12345&mineProvider=github&excludeStatus=archived",
      { headers: await authHeaders() }
    );
    expect(response.status).toBe(200);
    const body = await response.json<ListSessionsBody>();
    expect(body.sessions.map((s) => s.id)).toEqual(["alice-active"]);
    expect(body.total).toBe(1);
  });

  it("preserves sort order (updated_at DESC) and pagination shape under mine filter", async () => {
    const store = new SessionIndexStore(env.DB);
    const userStore = new UserStore(env.DB);

    const alice = await userStore.resolveOrCreateUser({
      provider: "github",
      providerUserId: "12345",
      providerLogin: "alice",
    });
    for (let i = 0; i < 5; i++) {
      await seedSession(store, {
        id: `alice-${i}`,
        userId: alice.id,
        updatedAt: i * 1000,
      });
    }

    const response = await SELF.fetch(
      "https://test.local/sessions?mineScmUserId=12345&mineProvider=github&limit=2&offset=1",
      { headers: await authHeaders() }
    );
    expect(response.status).toBe(200);
    const body = await response.json<ListSessionsBody>();
    expect(body.sessions.map((s) => s.id)).toEqual(["alice-3", "alice-2"]);
    expect(body.total).toBe(5);
    expect(body.hasMore).toBe(true);
  });
});
