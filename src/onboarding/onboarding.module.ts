import { Body, Controller, Injectable, Module, Post, Req, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, MinLength } from "class-validator";
import { OrganizationType } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { ClerkAuthGuard, AuthedRequest } from "../auth/clerk-auth.guard";

// These two endpoints are the actual chicken-and-egg case in Phase 4's
// signup flows (sections 2.1/2.2): a brand-new user has no Membership
// and no ContractorCompanyMembership yet, so ContextGuard's normal
// resolution would reject them — there's no tenant to resolve *into*.
// These use ClerkAuthGuard only (identity, not tenant context) and are
// the one place a Membership/ContractorCompanyMembership row gets
// created from nothing rather than added to an existing tenant.

class CreateOrganizationDto {
  @IsString() @MinLength(1) name!: string;
  @IsIn(["individual", "property_management", "hotel", "hospital", "school", "mall", "office", "industrial"])
  type!: OrganizationType;
  @IsString() billingEmail!: string;
}

class CreateContractorCompanyDto {
  @IsString() @MinLength(1) name!: string;
  @IsInt() serviceRadiusKm!: number;
  @IsLatitude() baseLat!: number;
  @IsLongitude() baseLng!: number;
  @IsOptional() @IsString({ each: true }) serviceCategoryIds?: string[];
}

@Injectable()
class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Phase 4 section 2.1 — the signing-up user becomes the first `owner` membership. */
  async createOrganization(clerkUserId: string, dto: CreateOrganizationDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { clerkUserId } });

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: dto.name, type: dto.type, billingEmail: dto.billingEmail },
      });
      await tx.membership.create({
        data: { userId: user.id, organizationId: organization.id, role: "owner", buildingScope: [] },
      });
      return organization;
    });
  }

  /**
   * Phase 4 section 2.2 — creates the company as `pending` verification
   * (Admin must approve before it can accept jobs, per Phase 3 section
   * 3.12's verification queue) and makes the creator a contractor_admin
   * via ContractorCompanyMembership — this is the row whose absence was
   * the Phase 6 schema gap.
   */
  async createContractorCompany(clerkUserId: string, dto: CreateContractorCompanyDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { clerkUserId } });

    return this.prisma.$transaction(async (tx) => {
      const company = await tx.contractorCompany.create({
        data: {
          name: dto.name,
          verificationStatus: "pending",
          serviceCategoryIds: dto.serviceCategoryIds ?? [],
          serviceRadiusKm: dto.serviceRadiusKm,
          baseLat: dto.baseLat,
          baseLng: dto.baseLng,
        },
      });
      await tx.contractorCompanyMembership.create({
        data: { userId: user.id, contractorCompanyId: company.id },
      });
      return company;
    });
  }
}

@Controller()
@UseGuards(ClerkAuthGuard)
class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post("organizations")
  createOrganization(@Req() req: AuthedRequest, @Body() dto: CreateOrganizationDto) {
    return this.onboarding.createOrganization(req.clerkUserId, dto);
  }

  @Post("contractor-companies")
  createContractorCompany(@Req() req: AuthedRequest, @Body() dto: CreateContractorCompanyDto) {
    return this.onboarding.createContractorCompany(req.clerkUserId, dto);
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, ClerkAuthGuard],
})
export class OnboardingModule {}
