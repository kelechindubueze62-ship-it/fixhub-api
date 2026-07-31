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
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from "class-validator";
import { JobStatus, JobPriority } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";
import { distanceKm } from "../common/geo.util";

class CreateJobDto {
  @IsUUID() buildingId!: string;
  @IsOptional() @IsUUID() assetId?: string;
  @IsUUID() serviceSubcategoryId!: string;
  @IsString() @MinLength(1) description!: string;
  @IsEnum(JobPriority) priority!: JobPriority;
  @IsOptional() @IsString() preferredDate?: string;
  @IsOptional() @IsString() preferredTimeWindow?: string;
}

class UpdateJobStatusDto {
  @IsEnum(JobStatus) status!: JobStatus;
  @IsOptional() @IsString() note?: string;
}

class ListJobsQueryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
}

export const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  submitted: ["assigned", "cancelled"],
  assigned: ["en_route", "cancelled"],
  en_route: ["arrived", "cancelled"],
  arrived: ["in_progress", "cancelled"],
  in_progress: ["awaiting_approval", "completed", "cancelled"],
  awaiting_approval: ["completed", "in_progress"],
  completed: ["closed"],
  closed: [],
  cancelled: [],
};

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  async list(ctx: RequestContext, pagination: ListJobsQueryDto) {
    const take = pagination.limit ?? 25;

    let items;
    if (ctx.scope === "organization") {
      items = await this.prisma.job.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(ctx.buildingScope ? { buildingId: { in: ctx.buildingScope } } : {}),
        },
        orderBy: { createdAt: "desc" },
        include: { building: true, serviceSubcategory: true },
        take: take + 1,
        ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
      });
    } else if (ctx.scope === "contractor") {
      items = await this.prisma.job.findMany({
        where: { contractorCompanyId: ctx.contractorCompanyId },
        orderBy: { createdAt: "desc" },
        include: { building: true, serviceSubcategory: true },
        take: take + 1,
        ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
      });
    } else {
      items = await this.prisma.job.findMany({
        orderBy: { createdAt: "desc" },
        include: { building: true, serviceSubcategory: true, organization: true },
        take: take + 1,
        ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
      });
    }

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async get(ctx: RequestContext, id: string) {
    const job = await this.prisma.job.findUnique({
      where: { id },
      include: { statusHistory: { orderBy: { createdAt: "asc" } }, media: true, quotations: true },
    });
    if (!job) throw new NotFoundException("Job not found");
    this.assertVisible(ctx, job.organizationId, job.contractorCompanyId);
    return job;
  }

  private assertVisible(ctx: RequestContext, organizationId: string, contractorCompanyId: string | null) {
    if (ctx.scope === "global") return;
    if (ctx.scope === "organization" && ctx.organizationId === organizationId) return;
    if (ctx.scope === "contractor" && ctx.contractorCompanyId === contractorCompanyId) return;
    throw new NotFoundException("Job not found");
  }

  async create(ctx: RequestContext, dto: CreateJobDto) {
    if (ctx.scope !== "organization") throw new ForbiddenException();

    const subcategory = await this.prisma.serviceSubcategory.findUniqueOrThrow({
      where: { id: dto.serviceSubcategoryId },
    });

    const job = await this.prisma.job.create({
      data: {
        organizationId: ctx.organizationId,
        buildingId: dto.buildingId,
        assetId: dto.assetId,
        serviceSubcategoryId: dto.serviceSubcategoryId,
        createdByUserId: ctx.userId,
        description: dto.description,
        priority: dto.priority,
        requiresInspection: subcategory.requiresInspection,
        source: dto.priority === "emergency" ? "emergency" : "manual",
        preferredDate: dto.priority === "emergency" ? null : dto.preferredDate,
        preferredTimeWindow: dto.priority === "emergency" ? null : dto.preferredTimeWindow,
      },
    });

    await this.prisma.jobStatusHistory.create({
      data: { jobId: job.id, status: "submitted", changedByUserId: ctx.userId },
    });

    if (dto.priority === "emergency") {
      await this.broadcastEmergencyJob(job.id);
    }

    return job;
  }

  private async broadcastEmergencyJob(jobId: string) {
    const job = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { building: true, serviceSubcategory: true },
    });

    const candidates = await this.prisma.technician.findMany({
      where: {
        status: "available",
        skillSubcategoryIds: { has: job.serviceSubcategoryId },
        contractorCompany: { verificationStatus: "verified" },
      },
      include: { contractorCompany: true, user: true },
    });

    const inRange = candidates.filter(
      (t) =>
        distanceKm(job.building.lat, job.building.lng, t.contractorCompany.baseLat, t.contractorCompany.baseLng) <=
        t.contractorCompany.serviceRadiusKm
    );

    await Promise.all(
      inRange.map((t) =>
        this.notifications.emit({
          userId: t.userId,
          eventType: "job_assigned",
          payload: {
            jobId: job.id,
            emergencyBroadcast: true,
            claimUrl: `/jobs/emergency-broadcast/${job.id}/claim`,
            building: job.building.name,
            service: job.serviceSubcategory.name,
          },
        })
      )
    );

    if (inRange.length === 0) {
      console.warn(`Emergency job ${job.id} has no available in-range technicians to notify`);
    }
  }

  async transitionStatus(ctx: RequestContext, jobId: string, dto: UpdateJobStatusDto) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException("Job not found");
    this.assertVisible(ctx, job.organizationId, job.contractorCompanyId);

    const allowed = ALLOWED_TRANSITIONS[job.status];
    if (!allowed.includes(dto.status)) {
      throw new ConflictException(
        `Cannot transition job from '${job.status}' to '${dto.status}'. Allowed: ${allowed.join(", ") || "none — terminal state"}`
      );
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.job.update({ where: { id: jobId }, data: { status: dto.status } }),
      this.prisma.jobStatusHistory.create({
        data: { jobId, status: dto.status, changedByUserId: ctx.userId, note: dto.note },
      }),
    ]);

    return updated;
  }
}

@Controller("jobs")
@UseGuards(ClerkAuthGuard, ContextGuard)
class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() pagination: ListJobsQueryDto) {
    return this.jobs.list(ctx, pagination);
  }

  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.jobs.get(ctx, id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateJobDto) {
    return this.jobs.create(ctx, dto);
  }

  @Patch(":id/status")
  transitionStatus(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: UpdateJobStatusDto
  ) {
    return this.jobs.transitionStatus(ctx, id, dto);
  }
}

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [JobsController],
  providers: [JobsService, ContextGuard],
})
export class JobsModule {}
