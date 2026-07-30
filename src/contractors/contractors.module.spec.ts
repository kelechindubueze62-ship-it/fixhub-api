import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ContractorsService } from "./contractors.module";
import type { RequestContext } from "../auth/types";
import { NotificationsService } from "../notifications/notifications.module";

// Phase 2 section 4.5 / Phase 1 section 6.4: emergency jobs broadcast to
// every available technician, and correctness depends entirely on the
// conditional `updateMany` (WHERE assigned_technician_id IS NULL) being a
// real compare-and-swap at the database level, not application-level
// locking. This test simulates that CAS semantics with an in-memory
// mock store so the two concurrent claimants race against the *same*
// piece of shared state, the way two API instances would race against
// the same Postgres row.

function makeTechnicianContext(userId: string): Extract<RequestContext, { scope: "contractor" }> {
  return { scope: "contractor", userId, contractorCompanyId: `contractor_of_${userId}`, role: "technician" };
}

function makeRacingPrismaMock() {
  // Shared mutable "row" both calls race against — mirrors a single
  // Postgres row two concurrent requests would both be updating.
  const row = { id: "job_1", priority: "emergency", status: "submitted", assignedTechnicianId: null as string | null, contractorCompanyId: null as string | null };

  return {
    technician: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve({ id: `tech_${where.userId}`, contractorCompanyId: `contractor_of_${where.userId}` })),
    },
    job: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...row })),
      // The critical line: only succeeds (count: 1) if assignedTechnicianId
      // is still null at the moment this runs — same guarantee Postgres's
      // WHERE clause gives us against real concurrent transactions.
      updateMany: jest.fn().mockImplementation(({ data }: any) => {
        if (row.assignedTechnicianId === null) {
          row.assignedTechnicianId = data.assignedTechnicianId;
          row.contractorCompanyId = data.contractorCompanyId;
          row.status = data.status;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
    },
    jobStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe("ContractorsService.claimEmergencyJob — concurrency", () => {
  it("lets exactly one of two simultaneous claimants win", async () => {
    const prisma = makeRacingPrismaMock();
    const notifications = { emit: jest.fn().mockResolvedValue({}) } as unknown as NotificationsService;
    const service = new ContractorsService(prisma as any, notifications);

    const results = await Promise.allSettled([
      service.claimEmergencyJob(makeTechnicianContext("tech_a"), "job_1"),
      service.claimEmergencyJob(makeTechnicianContext("tech_b"), "job_1"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it("rejects a non-technician attempting to claim", async () => {
    const prisma = makeRacingPrismaMock();
    const notifications = { emit: jest.fn() } as unknown as NotificationsService;
    const service = new ContractorsService(prisma as any, notifications);

    const orgCtx: RequestContext = {
      scope: "organization",
      userId: "usr_1",
      organizationId: "org_1",
      role: "owner",
      buildingScope: null,
      spendApprovalLimit: null,
    };

    await expect(service.claimEmergencyJob(orgCtx, "job_1")).rejects.toThrow(ForbiddenException);
  });
});
