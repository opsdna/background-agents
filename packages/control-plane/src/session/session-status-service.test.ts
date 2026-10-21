import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createLogger } from "../logger";
import { createMockSession } from "../sandbox/lifecycle/test-helpers";
import type { ArtifactRepository } from "./artifact-repository";
import type { MessageRepository } from "./message-repository";
import type { SessionRuntimeClient } from "./runtime-client";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionMessenger } from "./messenger";
import { SessionStatusService } from "./session-status-service";

function harness() {
  const repository = {
    getSession: () => createMockSession(),
    updateSessionStatus: vi.fn(),
  };
  const statusProjection = { project: vi.fn(async () => true) };
  const onStatusChange = vi.fn();
  const service = new SessionStatusService(
    createTestBackgroundTasks(),
    createLogger("control-plane"),
    repository as unknown as SessionCoreRepository,
    {} as MessageRepository,
    {} as ArtifactRepository,
    { getSessionTotals: vi.fn() },
    { broadcast: vi.fn(), sendToSandbox: vi.fn() } as SessionMessenger,
    { finalizeChildAdmission: vi.fn(), updateMetrics: vi.fn() },
    statusProjection,
    { fetch: vi.fn() } as SessionRuntimeClient,
    onStatusChange
  );
  return { service, repository, statusProjection, onStatusChange };
}

describe("SessionStatusService.transition", () => {
  it("notifies resource lifecycle after a committed transition", async () => {
    const h = harness();

    await h.service.transition("created");

    const session = h.repository.getSession();
    expect(h.onStatusChange).toHaveBeenCalledWith(
      session.session_name ?? session.id,
      "created",
      expect.any(Number)
    );
  });

  it("does not notify resource lifecycle for an unchanged status", async () => {
    const h = harness();

    await h.service.transition(h.repository.getSession().status);

    expect(h.onStatusChange).not.toHaveBeenCalled();
  });

  it("keeps local write failures as promise rejections", async () => {
    const h = harness();
    h.repository.updateSessionStatus.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    await expect(h.service.transition("archived")).rejects.toThrow("local status write failed");
    expect(h.statusProjection.project).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.beginTransition", () => {
  it("throws a local write failure synchronously without starting projection", () => {
    const h = harness();
    h.repository.updateSessionStatus.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    expect(() => h.service.beginTransition("archived")).toThrow("local status write failed");
    expect(h.statusProjection.project).not.toHaveBeenCalled();
  });
});
