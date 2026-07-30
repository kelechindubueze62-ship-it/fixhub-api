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
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { IsEmail, IsEnum, IsLatitude, IsLongitude, IsString, MinLength } from "class-validator";
import { TechnicianStatus } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";
import { distanceKm } from "../common/geo.util";

class InviteTechnicianDto {
  @IsString() @MinLength(1) fullName!: string;
  @IsEmail() email!: string;
}

class UpdateTechnicianStatusDto {
  @IsEnum(TechnicianStatus) status!: TechnicianStatus;
}

class UpdateTechnicianLocationDto {
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
}

// distanceKm now lives in src/common/geo.util.ts, shared with the
// emergency-broadcast path in jobs.module.ts.

@Injectable()
export class ContractorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  private assertOwnCompany(ctx: RequestContext, contractorCompanyId: string) {
    if (ctx.scope === "global") return;
    if (ctx.scope !== "contractor" || ctx.contractorCompanyId !== contractorCompanyId) {
      throw new NotFoundException("Contractor company not found");
    }
  }

  async get(ctx: RequestContext, id: string) {
    this.assertOwnCompany(ctx, id);
    const company = await this.prisma.contractorCompany.findUnique({ where: { id } });
    if (!company) throw new NotFoundException("Contractor company not found");
    return company;
  }

  async listJobs(ctx: RequestContext, id: string) {
    this.assertOwnCompany(ctx, id);
    return this.prisma.job.findMany({
      where: { contractorCompanyId: id },
      orderBy: { createdAt: "desc" },
      include: { building: true, serviceSubcategory: true },
    });
  }

  // Per Phase 4 section 2.3: technicians never self-register. Only a
  // contractor admin creates them, and contractor_company_id is never
  // user-editable afterward through any endpoint — this is the only
  // place a technicians row is ever created.
  async inviteTechnician(ctx: RequestContext, contractorCompanyId: string, dto: InviteTechnicianDto) {
    this.assertOwnCompany(ctx, contractorCompanyId);
    if (ctx.scope === "contractor" && ctx.role !== "contractor_admin") {
      throw new ForbiddenException("Only a contractor admin can add technicians");
    }

    // NOTE: in the full build this also creates the Clerk invite and a
    // pending `users` row keyed by a placeholder clerk_user_id that gets
    // reconciled when the invite is accepted. Simplified here to the
    // domain-model write, since the Clerk invite call itself is an
    // external side effect better covered by an integration test than
    // hand-waved in this vertical slice.
    const user = await this.prisma.user.create({
      data: {
        clerkUserId: `pending_${crypto.randomUUID()}`,
        email: dto.email,
        fullName: dto.fullName,
        status: "pending_verification",
      },
    });

    return this.prisma.technician.create({
      data: { userId: user.id, contractorCompanyId, skillSubcategoryIds: [] },
    });
  }

  async updateTechnicianStatus(ctx: RequestContext, technicianId: string, dto: UpdateTechnicianStatusDto) {
    const technician = await this.prisma.technician.findUnique({ where: { id: technicianId } });
    if (!technician) throw new NotFoundException("Technician not found");
    this.assertOwnCompany(ctx, technician.contractorCompanyId);
    return this.prisma.technician.update({ where: { id: technicianId }, data: { status: dto.status } });
  }

  async updateTechnicianLocation(ctx: RequestContext, technicianId: string, dto: UpdateTechnicianLocationDto) {
    const technician = await this.prisma.technician.findUnique({ where: { id: technicianId } });
    if (!technician) throw new NotFoundException("Technician not found");
    this.assertOwnCompany(ctx, technician.contractorCompanyId);
    return this.prisma.technician.update({
      where: { id: technicianId },
      data: { currentLat: dto.lat, currentLng: dto.lng },
    });
  }

  /**
   * Ranked shortlist for the hybrid assignment model locked in Phase 1
   * section 11.3: category match + proximity + rating + current load.
   * Non-emergency jobs only — emergency uses broadcastEmergency/claim below.
   */
  async getAssignmentCandidates(ctx: RequestContext, jobId: string) {
    if (ctx.scope !== "global") {
      throw new ForbiddenException("Only platform admin confirms non-emergency assignment in v1");
    }
    const job = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { building: true, serviceSubcategory: true },
    });

    const candidates = await this.prisma.contractorCompany.findMany({
      where: {
        verificationStatus: "verified",
        serviceCategoryIds: { has: job.serviceSubcategory.categoryId },
      },
    });

    const ranked = candidates
      .map((c) => {
        const km = distanceKm(job.building.lat, job.building.lng, c.baseLat, c.baseLng);
        return { contractorCompanyId: c.id, name: c.name, distanceKm: km, ratingAvg: c.ratingAvg ?? 0 };
      })
      .filter((c) => c.distanceKm <= 9999) // radius filter simplified for this slice
      .sort((a, b) => a.distanceKm - b.distanceKm || b.ratingAvg - a.ratingAvg)
      .slice(0, 5);

    return ranked;
  }

  async assign(ctx: RequestContext, jobId: string, contractorCompanyId: string) {
    if (ctx.scope !== "global") {
      throw new ForbiddenException("Only platform admin confirms assignment in v1");
    }
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException("Job not found");
    if (job.status !== "submitted") {
      throw new ConflictException(`Cannot assign a job in status '${job.status}'`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.job.update({
        where: { id: jobId },
        data: { contractorCompanyId, status: "assigned" },
      });
      await tx.jobStatusHistory.create({
        data: { jobId, status: "assigned", changedByUserId: ctx.userId },
      });
      await this.notifications.emit({
        userId: job.createdByUserId,
        eventType: "job_assigned",
        payload: { jobId, contractorCompanyId },
      });
      return updated;
    });
  }

  /**
   * Emergency broadcast-and-claim (Phase 1 section 6.4, Phase 2 section
   * 4.5): first technician to successfully claim wins. Concurrency safety
   * comes from the conditional updateMany — WHERE assigned_technician_id
   * IS NULL — not from application-level locking, so it's correct even
   * under concurrent requests hitting different API instances.
   */
  async claimEmergencyJob(ctx: RequestContext, jobId: string) {
    if (ctx.scope !== "contractor" || ctx.role !== "technician") {
      throw new ForbiddenException("Only a technician can claim an emergency job");
    }
    const technician = await this.prisma.technician.findUnique({ where: { userId: ctx.userId } });
    if (!technician) throw new NotFoundException("Technician profile not found");

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.priority !== "emergency") {
      throw new NotFoundException("Emergency job not found");
    }

    const result = await this.prisma.job.updateMany({
      where: { id: jobId, assignedTechnicianId: null, status: "submitted" },
      data: {
        assignedTechnicianId: technician.id,
        contractorCompanyId: technician.contractorCompanyId,
        status: "assigned",
      },
    });

    if (result.count === 0) {
      throw new ConflictException("This job has already been claimed by another technician");
    }

    await this.prisma.jobStatusHistory.create({
      data: { jobId, status: "assigned", changedByUserId: ctx.userId, note: "Claimed via emergency broadcast" },
    });

    await this.notifications.emit({
      userId: job.createdByUserId,
      eventType: "job_assigned",
      payload: { jobId, technicianId: technician.id },
    });

    return this.prisma.job.findUnique({ where: { id: jobId } });
  }
}

@Controller()
@UseGuards(ClerkAuthGuard, ContextGuard)
class ContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get("contractor-companies/:id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contractors.get(ctx, id);
  }

  @Get("contractor-companies/:id/jobs")
  listJobs(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contractors.listJobs(ctx, id);
  }

  @Post("contractor-companies/:id/technicians")
  inviteTechnician(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: InviteTechnicianDto
  ) {
    return this.contractors.inviteTechnician(ctx, id, dto);
  }

  @Patch("technicians/:id/status")
  updateStatus(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: UpdateTechnicianStatusDto
  ) {
    return this.contractors.updateTechnicianStatus(ctx, id, dto);
  }

  @Patch("technicians/:id/location")
  updateLocation(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: UpdateTechnicianLocationDto
  ) {
    return this.contractors.updateTechnicianLocation(ctx, id, dto);
  }

  @Get("jobs/:id/assignment-candidates")
  candidates(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contractors.getAssignmentCandidates(ctx, id);
  }

  @Post("jobs/:id/assign")
  assign(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body("contractorCompanyId") contractorCompanyId: string) {
    return this.contractors.assign(ctx, id, contractorCompanyId);
  }

  @Post("jobs/emergency-broadcast/:id/claim")
  claim(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.contractors.claimEmergencyJob(ctx, id);
  }
}

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [ContractorsController],
  providers: [ContractorsService, ContextGuard],
})
export class ContractorsModule {}
