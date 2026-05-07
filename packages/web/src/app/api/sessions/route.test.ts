import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

function makeNextRequest(url: string): Parameters<typeof GET>[0] {
  // The BFF route uses `request.nextUrl.searchParams`. Provide a minimal
  // structural object that matches the parts the handler reads.
  const u = new URL(url);
  return {
    nextUrl: u,
    url,
  } as unknown as Parameters<typeof GET>[0];
}

describe("sessions API GET route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(makeNextRequest("http://localhost/api/sessions"));

    expect(response.status).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards plain list call with no mine flag", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "alice" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], total: 0, hasMore: false })
    );

    const response = await GET(
      makeNextRequest("http://localhost/api/sessions?excludeStatus=archived&limit=50")
    );

    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
    const path = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path).toBe("/sessions?limit=50&excludeStatus=archived");
    expect(response.status).toBe(200);
  });

  it("translates ?mine=true into server-derived mineScmUserId+mineProvider", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "alice" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], total: 0, hasMore: false })
    );

    await GET(makeNextRequest("http://localhost/api/sessions?mine=true&excludeStatus=archived"));

    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
    const path = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path).toContain("mineScmUserId=12345");
    expect(path).toContain("mineProvider=github");
    expect(path).toContain("excludeStatus=archived");
  });

  it("does NOT forward client-supplied mineScmUserId (spoof-resistance, spec AC 10)", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "alice" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], total: 0, hasMore: false })
    );

    await GET(
      makeNextRequest(
        "http://localhost/api/sessions?mine=true&mineScmUserId=99999&mineProvider=facebook"
      )
    );

    const path = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path).toContain("mineScmUserId=12345");
    expect(path).not.toContain("mineScmUserId=99999");
    expect(path).toContain("mineProvider=github");
    expect(path).not.toContain("mineProvider=facebook");
  });

  it("does NOT add mineScmUserId when mine is absent or false", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "alice" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], total: 0, hasMore: false })
    );

    await GET(makeNextRequest("http://localhost/api/sessions?mine=false"));
    const path1 = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path1).not.toContain("mineScmUserId");
    expect(path1).not.toContain("mineProvider");

    vi.mocked(controlPlaneFetch).mockClear();
    await GET(makeNextRequest("http://localhost/api/sessions"));
    const path2 = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path2).not.toContain("mineScmUserId");
    expect(path2).not.toContain("mineProvider");
  });

  it("strips client-supplied identity even when mine flag is absent", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "12345", login: "alice" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ sessions: [], total: 0, hasMore: false })
    );

    await GET(
      makeNextRequest(
        "http://localhost/api/sessions?mineScmUserId=99999&mineProvider=github&excludeStatus=archived"
      )
    );

    const path = vi.mocked(controlPlaneFetch).mock.calls[0][0];
    expect(path).not.toContain("mineScmUserId");
    expect(path).not.toContain("mineProvider");
    expect(path).toContain("excludeStatus=archived");
  });
});
