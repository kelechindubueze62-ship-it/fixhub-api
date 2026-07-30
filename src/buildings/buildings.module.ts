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
import { Type } from "class-transformer";
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Max, Min, MinLength } from "class-validator";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";

class CreateBuildingDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) address!: string;
  @IsLatitude() lat!: number;
  @IsLongitude() lng!: number;
  @IsString() buildingType!: string;
  @IsOptional() @IsInt() floors?: number;
  @IsOptional() @IsInt() units?: number;
}

class UpdateBuildingDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsInt() floors?: number;
  @IsOptional() @IsInt() units?: number;
}

class ListBuildingsQueryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 25;
}

// Enforces tenant + building_scope on every read/write, per Phase 4
// section 5. An out-of-scope building_id should 404, not 403 — returning
// 403 would confirm the building exists, which leaks information about
// other tenants' data.
function assertOrgScope(ctx: RequestContext, organizationId: string) {
  if (ctx.scope === "global") return; // admin
  if (ctx.scope !== "organization" || ctx.organizationId !== organizationId) {
    throw new NotFoundException("Building not found");
  }
}

function assertBuildingInScope(ctx: RequestContext, buildingId: string) {
  if (ctx.scope === "organization" && ctx.buildingScope && !ctx.buildingScope.includes(buildingId)) {
    throw new NotFoundException("Building not found");
  }
}

@Injectable()
class BuildingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext, pagination: ListBuildingsQueryDto) {
    if (ctx.scope !== "organization" && ctx.scope !== "global") {
      throw new ForbiddenException();
    }
    const take = pagination.limit ?? 25;
    const items = await this.prisma.building.findMany({
      where: {
        deletedAt: null,
        ...(ctx.scope === "organization" ? { organizationId: ctx.organizationId } : {}),
        ...(ctx.scope === "organization" && ctx.buildingScope ? { id: { in: ctx.buildingScope } } : {}),
      },
      include: { _count: { select: { assets: true, jobs: true } } },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const page = hasMore ? items.slice(0, take) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async get(ctx: RequestContext, id: string) {
    const building = await this.prisma.building.findFirst({ where: { id, deletedAt: null } });
    if (!building) throw new NotFoundException("Building not found");
    assertOrgScope(ctx, building.organizationId);
    assertBuildingInScope(ctx, building.id);
    return building;
  }

  async create(ctx: RequestContext, dto: CreateBuildingDto) {
    if (ctx.scope !== "organization" || ctx.role === "staff_viewer") {
      throw new ForbiddenException("Only owners and facility managers can add buildings");
    }
    return this.prisma.building.create({
      data: { ...dto, organizationId: ctx.organizationId },
    });
  }

  async update(ctx: RequestContext, id: string, dto: UpdateBuildingDto) {
    const building = await this.get(ctx, id); // reuses scope checks
    if (ctx.scope === "organization" && ctx.role === "staff_viewer") {
      throw new ForbiddenException();
    }
    return this.prisma.building.update({ where: { id: building.id }, data: dto });
  }
}

@Controller("buildings")
@UseGuards(ClerkAuthGuard, ContextGuard)
class BuildingsController {
  constructor(private readonly buildings: BuildingsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() pagination: ListBuildingsQueryDto) {
    return this.buildings.list(ctx, pagination);
  }

  @Get(":id")
  get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.buildings.get(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateBuildingDto) {
    return this.buildings.create(ctx, dto);
  }

  @Patch(":id")
  update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body() dto: UpdateBuildingDto) {
    return this.buildings.update(ctx, id, dto);
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BuildingsController],
  providers: [BuildingsService, ContextGuard],
})
export class BuildingsModule {}
