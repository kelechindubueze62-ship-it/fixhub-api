import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { IsEnum, IsOptional, IsString } from "class-validator";
import { DisputeStatus, Prisma, UserStatus, VerificationStatus } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";

class UpdateUserStatusDto {
  @IsEnum(UserStatus) status!: UserStatus;
}

class VerifyContractorDto {
  @IsEnum(VerificationStatus) status!: VerificationStatus;
}

class ResolveDisputeDto {
  @IsEnum(DisputeStatus) status!: DisputeStatus;
  @IsOptional() @IsString() resolutionNote?: string;
}

function assertAdmin(ctx: RequestContext) {
  if (ctx.scope !== "global") throw new ForbiddenException("Admin access required");
}

@Injectable()
class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  async listUsers(ctx: RequestContext) {
    assertAdmin(ctx);
    return this.prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  }

  async updateUserStatus(ctx: RequestContext, userId: string, dto: UpdateUserStatusDto) {
    assertAdmin(ctx);
    return this.prisma.user.update({ where: { id: userId }, data: { status: dto.status } });
  }

  async listContractorCompanies(ctx: RequestContext) {
    assertAdmin(ctx);
    return this.prisma.contractorCompany.findMany({ orderBy: { createdAt: "desc" } });
  }

  async verifyContractorCompany(ctx: RequestContext, id: string, dto: VerifyContractorDto) {
    assertAdmin(ctx);
    const company = await this.prisma.contractorCompany.findUnique({ where: { id } });
    if (!company) throw new NotFoundException("Contractor company not found");

    const updated = await this.prisma.contractorCompany.update({
      where: { id },
      data: { verificationStatus: dto.status },
    });

    await this.prisma.auditLog.create({
      data: {
        actorUserId: ctx.userId,
        action: "contractor_verification_changed",
        targetType: "contractor_company",
        targetId: id,
        metadata: { newStatus: dto.status } as Prisma.InputJsonValue,
      },
    });

    return updated;
  }

  async listAllJobs(ctx: RequestContext) {
    assertAdmin(ctx);
    return this.prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      include: { building: true, organization: true, serviceSubcategory: true },
    });
  }

  async listDisputes(ctx: RequestContext) {
    assertAdmin(ctx);
    return this.prisma.dispute.findMany({ orderBy: { createdAt: "desc" }, include: { job: true } });
  }

  async resolveDispute(ctx: RequestContext, id: string, dto: ResolveDisputeDto) {
    assertAdmin(ctx);
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException("Dispute not found");

    return this.prisma.dispute.update({
      where: { id },
      data: {
        status: dto.status,
        resolutionNote: dto.resolutionNote,
        resolvedByAdminId: dto.status === "resolved" || dto.status === "dismissed" ? ctx.userId : undefined,
      },
    });
  }

  async platformAnalyticsOverview(ctx: RequestContext) {
    assertAdmin(ctx);
    const [jobCount, contractorCount, pendingVerifications, paidInvoiceTotal] = await Promise.all([
      this.prisma.job.count(),
      this.prisma.contractorCompany.count({ where: { verificationStatus: "verified" } }),
      this.prisma.contractorCompany.count({ where: { verificationStatus: "pending" } }),
      this.prisma.invoice.aggregate({ where: { status: "paid" }, _sum: { total: true } }),
    ]);
    return {
      totalJobs: jobCount,
      verifiedContractors: contractorCount,
      pendingVerifications,
      platformRevenueMinorUnits: paidInvoiceTotal._sum.total ?? 0,
    };
  }
}

@Controller("admin")
@UseGuards(ClerkAuthGuard, ContextGuard)
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("users")
  listUsers(@Ctx() ctx: RequestContext) {
    return this.admin.listUsers(ctx);
  }

  @Patch("users/:id/status")
  updateUserStatus(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body() dto: UpdateUserStatusDto) {
    return this.admin.updateUserStatus(ctx, id, dto);
  }

  @Get("contractor-companies")
  listContractorCompanies(@Ctx() ctx: RequestContext) {
    return this.admin.listContractorCompanies(ctx);
  }

  @Patch("contractor-companies/:id/verify")
  verifyContractorCompany(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: VerifyContractorDto
  ) {
    return this.admin.verifyContractorCompany(ctx, id, dto);
  }

  @Get("jobs")
  listAllJobs(@Ctx() ctx: RequestContext) {
    return this.admin.listAllJobs(ctx);
  }

  @Get("disputes")
  listDisputes(@Ctx() ctx: RequestContext) {
    return this.admin.listDisputes(ctx);
  }

  @Patch("disputes/:id")
  resolveDispute(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body() dto: ResolveDisputeDto) {
    return this.admin.resolveDispute(ctx, id, dto);
  }

  @Get("analytics/overview")
  analyticsOverview(@Ctx() ctx: RequestContext) {
    return this.admin.platformAnalyticsOverview(ctx);
  }
}

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [AdminController],
  providers: [AdminService, ContextGuard],
})
export class AdminModule {}
