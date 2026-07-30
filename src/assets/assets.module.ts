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
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";
import { AssetType, Recurrence } from "@prisma/client";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";

class CreateAssetDto {
  @IsUUID() buildingId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsEnum(AssetType) assetType!: AssetType;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsDateString() installDate?: string;
  @IsOptional() @IsDateString() warrantyExpiry?: string;
}

class CreateMaintenanceScheduleDto {
  @IsUUID() serviceSubcategoryId!: string;
  @IsEnum(Recurrence) recurrence!: Recurrence;
  @IsInt() @Min(0) leadTimeDays!: number;
  @IsDateString() nextDueDate!: string;
}

// Same visibility rule Jobs and Buildings use: an asset is only visible
// through the building it belongs to, so scope is inherited rather than
// re-specified — one less place for a tenant-boundary bug to hide.
async function assertBuildingVisible(prisma: PrismaService, ctx: RequestContext, buildingId: string) {
  const building = await prisma.building.findFirst({ where: { id: buildingId, deletedAt: null } });
  if (!building) throw new NotFoundException("Building not found");
  if (ctx.scope === "global") return building;
  if (ctx.scope !== "organization" || ctx.organizationId !== building.organizationId) {
    throw new NotFoundException("Building not found");
  }
  if (ctx.buildingScope && !ctx.buildingScope.includes(buildingId)) {
    throw new NotFoundException("Building not found");
  }
  return building;
}

@Injectable()
class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForBuilding(ctx: RequestContext, buildingId: string) {
    await assertBuildingVisible(this.prisma, ctx, buildingId);
    return this.prisma.asset.findMany({
      where: { buildingId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(ctx: RequestContext, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, deletedAt: null },
      include: {
        maintenanceSchedules: { where: { active: true } },
        jobs: { orderBy: { createdAt: "desc" }, take: 20 },
      },
    });
    if (!asset) throw new NotFoundException("Asset not found");
    await assertBuildingVisible(this.prisma, ctx, asset.buildingId);
    return asset;
  }

  async create(ctx: RequestContext, dto: CreateAssetDto) {
    if (ctx.scope === "organization" && ctx.role === "staff_viewer") {
      throw new ForbiddenException();
    }
    await assertBuildingVisible(this.prisma, ctx, dto.buildingId);
    return this.prisma.asset.create({ data: { ...dto } });
  }

  async addMaintenanceSchedule(ctx: RequestContext, assetId: string, dto: CreateMaintenanceScheduleDto) {
    const asset = await this.get(ctx, assetId); // reuses visibility check
    if (ctx.scope === "organization" && ctx.role === "staff_viewer") {
      throw new ForbiddenException();
    }
    return this.prisma.maintenanceSchedule.create({
      data: { assetId: asset.id, ...dto },
    });
  }
}

@Controller()
@UseGuards(ClerkAuthGuard, ContextGuard)
class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get("buildings/:buildingId/assets")
  listForBuilding(@Ctx() ctx: RequestContext, @Param("buildingId") buildingId: string) {
    return this.assets.listForBuilding(ctx, buildingId);
  }

  @Post("buildings/:buildingId/assets")
  create(
    @Ctx() ctx: RequestContext,
    @Param("buildingId") buildingId: string,
    @Body() dto: Omit<CreateAssetDto, "buildingId">
  ) {
    return this.assets.create(ctx, { ...dto, buildingId });
  }

  @Get("assets/:id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.assets.get(ctx, id);
  }

  @Post("assets/:id/maintenance-schedules")
  addSchedule(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() dto: CreateMaintenanceScheduleDto
  ) {
    return this.assets.addMaintenanceSchedule(ctx, id, dto);
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AssetsController],
  providers: [AssetsService, ContextGuard],
})
export class AssetsModule {}
