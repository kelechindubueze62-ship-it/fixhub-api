import { ConflictException, NotFoundException } from "@nestjs/common";
import { JobsService, ALLOWED_TRANSITIONS } from "./jobs.module";
import type { RequestContext } from "../auth/types";

// This is the highest-value test in the codebase: the state machine is
// the enforcement point the entire product's trust model depends on
// (Phase 2 section 4.3). If this regresses, a job could skip a stage
// like "awaiting_approval" and get marked completed without the
// customer ever signing off.

function makeOrgContext(overrides: Partial<Extract<RequestContext, { scope: "organization" }>> = {}) {
  return {
    scope: "organization" as const,
    userId: "usr_1",
    organizationId: "org_1",
    role: "owner" as const,
    buildingScope: null,
    spendApprovalLimit: null,
    ...overrides,
  };
}

function makeNotificationsMock() {
  return { emit: jest.fn().mockResolvedValue({}) };
}

function makePrismaMock(job: Record<string, unknown>) {
  return {
    job: {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue({ ...job }),
    },
    jobStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

describe("ALLOWED_TRANSITIONS (Phase 2 section 4.3)", () => {
  it("has no transitions out of terminal states", () => {
    expect(ALLOWED_TRANSITIONS.closed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });

  it("only allows cancellation from in-flight, non-terminal states", () => {
    const cancellableFrom = Object.entries(ALLOWED_TRANSITIONS)
      .filter(([, next]) => next.includes("cancelled"))
      .map(([from]) => from);
    expect(cancellableFrom).toEqual(
      expect.arrayContaining(["submitted", "assigned", "en_route", "arrived", "in_progress"])
    );
    expect(cancellableFrom).not.toContain("completed");
    expect(cancellableFrom).not.toContain("closed");
  });

  it("does not allow skipping straight from submitted to completed", () => {
    expect(ALLOWED_TRANSITIONS.submitted).not.toContain("completed");
  });
});

describe("JobsService.transitionStatus", () => {
  it("allows a legal transition (submitted → assigned)", async () => {
    const prisma = makePrismaMock({ id: "job_1", status: "submitted", organizationId: "org_1", contractorCompanyId: null });
    const service = new JobsService(prisma as any, makeNotificationsMock() as any);

    await service.transitionStatus(makeOrgContext(), "job_1", { status: "assigned" });

    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: "assigned" },
    });
  });

  it("rejects an illegal transition (submitted → completed) with 409, not a silent no-op", async () => {
    const prisma = makePrismaMock({ id: "job_1", status: "submitted", organizationId: "org_1", contractorCompanyId: null });
    const service = new JobsService(prisma as any, makeNotificationsMock() as any);

    await expect(
      service.transitionStatus(makeOrgContext(), "job_1", { status: "completed" })
    ).rejects.toThrow(ConflictException);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it("rejects any transition attempted from a terminal state (closed)", async () => {
    const prisma = makePrismaMock({ id: "job_1", status: "closed", organizationId: "org_1", contractorCompanyId: null });
    const service = new JobsService(prisma as any, makeNotificationsMock() as any);

    await expect(
      service.transitionStatus(makeOrgContext(), "job_1", { status: "in_progress" })
    ).rejects.toThrow(ConflictException);
  });

  it("404s rather than 403s when the job belongs to a different organization", async () => {
    const prisma = makePrismaMock({ id: "job_1", status: "submitted", organizationId: "org_OTHER", contractorCompanyId: null });
    const service = new JobsService(prisma as any, makeNotificationsMock() as any);

    await expect(
      service.transitionStatus(makeOrgContext({ organizationId: "org_1" }), "job_1", { status: "assigned" })
    ).rejects.toThrow(NotFoundException);
  });

  it("allows awaiting_approval to route back to in_progress for rework", async () => {
    const prisma = makePrismaMock({ id: "job_1", status: "awaiting_approval", organizationId: "org_1", contractorCompanyId: null });
    const service = new JobsService(prisma as any, makeNotificationsMock() as any);

    await service.transitionStatus(makeOrgContext(), "job_1", { status: "in_progress" });

    expect(prisma.job.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: "in_progress" },
    });
  });
});
