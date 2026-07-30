import { Controller, Get, Module, UseGuards } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ClerkAuthGuard, AuthedRequest } from "./clerk-auth.guard";
import { RequestContextService } from "./request-context.service";
import { Req } from "@nestjs/common";

// GET /v1/me — the endpoint fixhub-web/src/lib/auth/resolve-context.ts
// calls. Response shape is UserIdentityDto (auth/types.ts), which mirrors
// the frontend's UserIdentity type field-for-field.
@Controller("me")
@UseGuards(ClerkAuthGuard)
export class MeController {
  constructor(private readonly contextService: RequestContextService) {}

  @Get()
  async getMe(@Req() req: AuthedRequest) {
    return this.contextService.getIdentity(req.clerkUserId);
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [MeController],
  providers: [RequestContextService, ClerkAuthGuard],
  exports: [RequestContextService, ClerkAuthGuard],
})
export class AuthModule {}
