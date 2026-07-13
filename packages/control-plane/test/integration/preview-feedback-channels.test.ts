import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

const NOW = Date.parse("2026-07-13T16:00:00.000Z");
const CHANNEL_KEY = "linear-org:opsdna/opsdna:feature_preview:pr-1548";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function claimBody(leaseOwner: string) {
  return {
    channelKey: CHANNEL_KEY,
    linearOrganizationId: "linear-org",
    repository: "opsdna/opsdna",
    deploymentKind: "feature_preview",
    previewId: "pr-1548",
    prNumber: 1548,
    baseBranch: "codex/preview-feedback-react-grab-spike",
    portalUrl: "https://opsdna-portal-pr-1548.example.workers.dev",
    leaseOwner,
    now: NOW,
    leaseDurationMs: 30_000,
    expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
  };
}

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
}

describe("preview feedback channel registry", () => {
  beforeEach(cleanD1Tables);

  it("grants one atomic lease and rejects a concurrent provisioner", async () => {
    const responses = await Promise.all([
      post("/preview-feedback/channels/claim", claimBody("worker-a")),
      post("/preview-feedback/channels/claim", claimBody("worker-b")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const bodies = await Promise.all(
      responses.map((response) =>
        response.json<{ claimed: boolean; channel: { leaseOwner: string } }>()
      )
    );
    const winner = bodies.find((body) => body.claimed)?.channel.leaseOwner;
    expect(["worker-a", "worker-b"]).toContain(winner);
    expect(bodies.every((body) => body.channel.leaseOwner === winner)).toBe(true);
  });

  it("updates under the lease, releases it, and preserves the channel", async () => {
    expect((await post("/preview-feedback/channels/claim", claimBody("worker-a"))).status).toBe(
      200
    );
    const update = await post("/preview-feedback/channels/update", {
      channelKey: CHANNEL_KEY,
      leaseOwner: "worker-a",
      now: NOW + 1,
      status: "tracking",
      baseSha: "a".repeat(40),
      parentLinearIssueId: "linear-parent-id",
      parentLinearIssueIdentifier: "OPS-1000",
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      channel: {
        status: "tracking",
        baseSha: "a".repeat(40),
        parentLinearIssueId: "linear-parent-id",
        leaseOwner: null,
      },
    });

    const nextClaim = await post("/preview-feedback/channels/claim", {
      ...claimBody("worker-b"),
      now: NOW + 2,
    });
    expect(nextClaim.status).toBe(200);
    expect(await nextClaim.json()).toMatchObject({ claimed: true });
  });

  it("rejects identity mismatches and stale lease updates", async () => {
    const mismatch = await post("/preview-feedback/channels/claim", {
      ...claimBody("worker-a"),
      channelKey: `${CHANNEL_KEY}-forged`,
    });
    expect(mismatch.status).toBe(400);

    await post("/preview-feedback/channels/claim", claimBody("worker-a"));
    const staleUpdate = await post("/preview-feedback/channels/update", {
      channelKey: CHANNEL_KEY,
      leaseOwner: "worker-b",
      now: NOW + 1,
      status: "tracking",
    });
    expect(staleUpdate.status).toBe(409);
  });
});
