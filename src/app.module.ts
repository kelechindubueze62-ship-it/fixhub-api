import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { BuildingsModule } from "./buildings/buildings.module";
import { JobsModule } from "./jobs/jobs.module";
import { AssetsModule } from "./assets/assets.module";
import { QuotationsModule } from "./quotations/quotations.module";
import { PaymentsModule } from "./payments/payments.module";
import { ContractorsModule } from "./contractors/contractors.module";
import { AdminModule } from "./admin/admin.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MessagesModule } from "./messages/messages.module";
import { HealthModule } from "./health.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { ClerkWebhookModule } from "./clerk-webhook/clerk-webhook.module";
import { MaintenanceSchedulerModule } from "./maintenance-scheduler/maintenance-scheduler.module";

@Module({
  imports: [
    // Global default: 100 req/min per client. Section 4.5 of the Phase 2
    // API design specifically calls out POST /jobs and POST /messages for
    // stricter limits — those are applied per-route via @Throttle(),
    // not by lowering this global default (which would over-restrict
    // ordinary read traffic like dashboard polling).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    OnboardingModule,
    ClerkWebhookModule,
    BuildingsModule,
    JobsModule,
    AssetsModule,
    QuotationsModule,
    PaymentsModule,
    ContractorsModule,
    AdminModule,
    NotificationsModule,
    MessagesModule,
    HealthModule,
    MaintenanceSchedulerModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
