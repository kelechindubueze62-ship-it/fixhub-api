import {
  Body,
  Controller,
  ForbiddenException,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationsModule, NotificationsService } from "../notifications/notifications.module";

class LineItemDto {
  @IsString() @MinLength(1) description!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsInt() @Min(0) unitPrice!: number; // minor units
}

class CreateQuotationDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => LineItemDto)
  lineItems!: LineItemDto[];
  @IsInt() @Min(0) tax!: number;
  @IsString() currency!: string;
  @IsOptional() @IsString() notes?: string;
}

@Injectable()
class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  async submit(ctx: RequestContext, jobId: string, dto: CreateQuotationDto) {
    if (ctx.scope !== "contractor") throw new ForbiddenException("Only contractors submit quotations");

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.contractorCompanyId !== ctx.contractorCompanyId) {
      throw new NotFoundException("Job not found");
    }
    if (!job.requiresInspection) {
      throw new ConflictException("This job's service category doesn't require a quotation");
    }

    const subtotal = dto.lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);
    const total = subtotal + dto.tax;

    const quotation = await this.prisma.quotation.create({
      data: {
        jobId,
        contractorCompanyId: ctx.contractorCompanyId,
        status: "submitted",
        subtotal,
        tax: dto.tax,
        total,
        currency: dto.currency,
        notes: dto.notes,
        lineItems: {
          create: dto.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            lineTotal: li.quantity * li.unitPrice,
          })),
        },
      },
      include: { lineItems: true },
    });

    await this.prisma.job.update({ where: { id: jobId }, data: { status: "assigned" } });
    await this.notifications.emit({
      userId: job.createdByUserId,
      eventType: "quotation_ready",
      payload: { jobId, quotationId: quotation.id, total: quotation.total, currency: quotation.currency },
    });

    return quotation;
  }

  /**
   * Implements the exact guard sketched in Phase 4 section 3.3: an owner
   * can approve anything, but a facility_manager can only approve up to
   * their org's spend_approval_limit — over that, the request is rejected
   * so it routes back to an owner instead.
   */
  async approve(ctx: RequestContext, quotationId: string) {
    if (ctx.scope !== "organization" || !["owner", "facility_manager"].includes(ctx.role)) {
      throw new ForbiddenException();
    }

    const quotation = await this.prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { job: true },
    });
    if (!quotation || quotation.job.organizationId !== ctx.organizationId) {
      throw new NotFoundException("Quotation not found");
    }
    if (ctx.buildingScope && !ctx.buildingScope.includes(quotation.job.buildingId)) {
      throw new NotFoundException("Quotation not found");
    }
    if (quotation.status !== "submitted") {
      throw new ConflictException(`Cannot approve a quotation in status '${quotation.status}'`);
    }
    if (ctx.role === "facility_manager") {
      const limit = ctx.spendApprovalLimit;
      if (limit === null || quotation.total > limit) {
        throw new ForbiddenException(
          "This quotation exceeds your spend approval limit — an owner needs to approve it"
        );
      }
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.quotation.update({ where: { id: quotationId }, data: { status: "approved" } }),
      this.prisma.invoice.create({
        data: {
          jobId: quotation.jobId,
          organizationId: quotation.job.organizationId,
          quotationId: quotation.id,
          status: "issued",
          total: quotation.total,
          currency: quotation.currency,
        },
      }),
    ]);

    return updated;
  }

  async decline(ctx: RequestContext, quotationId: string, reason?: string) {
    if (ctx.scope !== "organization" || !["owner", "facility_manager"].includes(ctx.role)) {
      throw new ForbiddenException();
    }
    const quotation = await this.prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { job: true },
    });
    if (!quotation || quotation.job.organizationId !== ctx.organizationId) {
      throw new NotFoundException("Quotation not found");
    }
    return this.prisma.quotation.update({
      where: { id: quotationId },
      data: { status: "declined", notes: reason ?? quotation.notes },
    });
  }
}

@Controller()
@UseGuards(ClerkAuthGuard, ContextGuard)
class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Post("jobs/:jobId/quotations")
  submit(@Ctx() ctx: RequestContext, @Param("jobId") jobId: string, @Body() dto: CreateQuotationDto) {
    return this.quotations.submit(ctx, jobId, dto);
  }

  @Post("quotations/:id/approve")
  approve(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.quotations.approve(ctx, id);
  }

  @Post("quotations/:id/decline")
  decline(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body("reason") reason?: string) {
    return this.quotations.decline(ctx, id, reason);
  }
}

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [QuotationsController],
  providers: [QuotationsService, ContextGuard],
})
export class QuotationsModule {}
