import { ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.module";
import type { RequestContext, UserIdentityDto } from "./types";

// This is the single source of truth for "what can this request do."
// Every controller resolves context through here — nothing trusts a
// role/org claim sent by the client, per Phase 4 section 1: caching role
// in a JWT would mean a revoked membership stays valid until the token
// expires, which is not acceptable for a marketplace with money and
// physical access involved.
@Injectable()
export class RequestContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getIdentity(clerkUserId: string): Promise<UserIdentityDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { clerkUserId },
      include: {
        memberships: { include: { organization: true } },
        technician: { include: { contractorCompany: true } },
        contractorCompanyMemberships: { include: { contractorCompany: true } },
      },
    });

    const organizationMemberships = user.memberships.map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organization.name,
      role: m.role,
      buildingScope: m.buildingScope.length > 0 ? m.buildingScope : null,
      spendApprovalLimit: m.role === "facility_manager" ? m.organization.spendApprovalLimit : null,
    }));

    // A user can hold a contractor_admin membership AND/OR a technician
    // row — e.g. a small contracting outfit's owner who also takes jobs
    // personally. Both are surfaced; RequestContextService picks the
    // right one based on which contractorCompanyId the client asks for.
    const adminMemberships = user.contractorCompanyMemberships.map((m) => ({
      contractorCompanyId: m.contractorCompanyId,
      contractorCompanyName: m.contractorCompany.name,
      role: "contractor_admin" as const,
      verificationStatus: m.contractorCompany.verificationStatus,
    }));

    const technicianMembership = user.technician
      ? [
          {
            contractorCompanyId: user.technician.contractorCompanyId,
            contractorCompanyName: user.technician.contractorCompany.name,
            role: "technician" as const,
            verificationStatus: user.technician.contractorCompany.verificationStatus,
          },
        ]
      : [];

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      platformRole: user.platformRole ?? null,
      organizationMemberships,
      contractorMemberships: [...adminMemberships, ...technicianMembership],
    };
  }

  /**
   * Resolves the RequestContext for a single request, given the tenant the
   * client asked for via X-Org-Id / X-Contractor-Id (set by the frontend's
   * role switcher — Phase 4 section 4). Never falls back to "some other
   * tenant the user happens to have access to" — an out-of-scope request
   * fails closed.
   */
  async resolve(clerkUserId: string, requestedTenantId?: string): Promise<RequestContext> {
    const identity = await this.getIdentity(clerkUserId);

    if (identity.platformRole === "admin") {
      return { scope: "global", userId: identity.userId };
    }

    if (requestedTenantId) {
      const org = identity.organizationMemberships.find((m) => m.organizationId === requestedTenantId);
      if (org) {
        return {
          scope: "organization",
          userId: identity.userId,
          organizationId: org.organizationId,
          role: org.role,
          buildingScope: org.buildingScope,
          spendApprovalLimit: org.spendApprovalLimit,
        };
      }

      const contractor = identity.contractorMemberships.find(
        (m) => m.contractorCompanyId === requestedTenantId
      );
      if (contractor) {
        return {
          scope: "contractor",
          userId: identity.userId,
          contractorCompanyId: contractor.contractorCompanyId,
          role: contractor.role,
        };
      }

      throw new ForbiddenException("No membership in the requested tenant");
    }

    const [firstOrg] = identity.organizationMemberships;
    if (firstOrg) {
      return {
        scope: "organization",
        userId: identity.userId,
        organizationId: firstOrg.organizationId,
        role: firstOrg.role,
        buildingScope: firstOrg.buildingScope,
        spendApprovalLimit: firstOrg.spendApprovalLimit,
      };
    }

    const [firstContractor] = identity.contractorMemberships;
    if (firstContractor) {
      return {
        scope: "contractor",
        userId: identity.userId,
        contractorCompanyId: firstContractor.contractorCompanyId,
        role: firstContractor.role,
      };
    }

    throw new ForbiddenException("User has no organization or contractor membership");
  }
}
