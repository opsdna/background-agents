import { describe, expect, it } from "vitest";
import { buildControlPlanePath, SESSION_CONTROL_PLANE_QUERY_PARAMS } from "./control-plane-query";

describe("buildControlPlanePath", () => {
  it("forwards allowed query parameters in allowlist order", () => {
    const searchParams = new URLSearchParams("offset=20&debug=true&limit=10&status=running");

    expect(buildControlPlanePath("/sessions", searchParams)).toBe(
      "/sessions?status=running&limit=10&offset=20"
    );
  });

  it("omits query strings when no allowed parameters are present", () => {
    const searchParams = new URLSearchParams("repoOwner=open-inspect&trace=1");

    expect(buildControlPlanePath("/automations", searchParams)).toBe("/automations");
  });

  it("preserves empty allowed values", () => {
    const searchParams = new URLSearchParams("limit=&status=");

    expect(buildControlPlanePath("/automations/run", searchParams)).toBe(
      "/automations/run?status=&limit="
    );
  });

  it("preserves repeated values for allowed query parameters", () => {
    const searchParams = new URLSearchParams("status=running&status=failed&limit=10");

    expect(buildControlPlanePath("/sessions", searchParams)).toBe(
      "/sessions?status=running&status=failed&limit=10"
    );
  });

  it("supports route-specific allowlists", () => {
    const searchParams = new URLSearchParams("excludeStatus=archived&status=running&debug=true");

    expect(
      buildControlPlanePath("/sessions", searchParams, SESSION_CONTROL_PLANE_QUERY_PARAMS)
    ).toBe("/sessions?status=running&excludeStatus=archived");
  });

  it("does NOT forward mineScmUserId or mineProvider from clients (server-trusted only)", () => {
    // mineScmUserId / mineProvider are inserted by the BFF after server-side
    // identity derivation. Anything supplied by the client must be stripped.
    const searchParams = new URLSearchParams(
      "mineScmUserId=99999&mineProvider=facebook&excludeStatus=archived"
    );

    expect(
      buildControlPlanePath("/sessions", searchParams, SESSION_CONTROL_PLANE_QUERY_PARAMS)
    ).toBe("/sessions?excludeStatus=archived");
  });

  it("does NOT forward the browser-facing mine flag (BFF translates it)", () => {
    const searchParams = new URLSearchParams("mine=true&limit=50");

    expect(
      buildControlPlanePath("/sessions", searchParams, SESSION_CONTROL_PLANE_QUERY_PARAMS)
    ).toBe("/sessions?limit=50");
  });
});
