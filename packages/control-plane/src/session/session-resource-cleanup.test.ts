import { describe, expect, it } from "vitest";
import { deleteDelayForSessionStatus } from "./session-resource-cleanup";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("session resource cleanup policy", () => {
  it("deletes cancelled resources immediately", () => {
    expect(deleteDelayForSessionStatus("cancelled")).toBe(0);
  });

  it("keeps completed and archived resources for a grace period", () => {
    expect(deleteDelayForSessionStatus("completed")).toBe(3 * DAY_MS);
    expect(deleteDelayForSessionStatus("archived")).toBe(3 * DAY_MS);
  });

  it("keeps failed resources long enough for debugging", () => {
    expect(deleteDelayForSessionStatus("failed")).toBe(DAY_MS);
  });

  it("does not schedule deletion for active sessions", () => {
    expect(deleteDelayForSessionStatus("active")).toBeNull();
  });
});
