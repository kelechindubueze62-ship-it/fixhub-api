// Mirrors fixhub-web/src/lib/auth/types.ts exactly — GET /v1/me returns
// UserIdentity in this shape so the frontend's resolve-context.ts can
// swap from MOCK_IDENTITY to a real fetch with no reshaping. If either
// side changes, change both together.

export type OrgRole = "owner" | "facility_manager" | "staff_viewer";
export type ContractorRole = "contractor_admin" | "technician";

export interface OrganizationMembershipDto {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  buildingScope: string[] | null;
  spendApprovalLimit: number | null;
}

export interface ContractorMembershipDto {
  contractorCompanyId: string;
  contractorCompanyName: string;
  role: ContractorRole;
  verificationStatus: "pending" | "verified" | "rejected" | "suspended";
}

export interface UserIdentityDto {
  userId: string;
  email: string;
  fullName: string;
  platformRole: "admin" | null;
  organizationMemberships: OrganizationMembershipDto[];
  contractorMemberships: ContractorMembershipDto[];
}

export type RequestContext =
  | { scope: "global"; userId: string }
  | {
      scope: "organization";
      userId: string;
      organizationId: string;
      role: OrgRole;
      buildingScope: string[] | null;
      spendApprovalLimit: number | null;
    }
  | {
      scope: "contractor";
      userId: string;
      contractorCompanyId: string;
      role: ContractorRole;
    };
