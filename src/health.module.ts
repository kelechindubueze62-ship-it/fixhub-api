import { Controller, Get, Module } from "@nestjs/common";
import { PrismaModule, PrismaService } from "./prisma/prisma.module";

// No auth guard — this is polled by Docker/Railway/load balancers, not
// logged-in users. Deliberately checks a real DB round trip rather than
// just returning 200, since "process is up" and "process can serve
// requests" are different failure modes worth distinguishing.
@Controller("health")
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", timestamp: new Date().toISOString() };
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class HealthModule {}
