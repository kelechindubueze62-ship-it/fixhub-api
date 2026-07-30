import { Body, Controller, Get, Injectable, Module, Param, Patch, UseGuards } from "@nestjs/common";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationChannel } from "@prisma/client";

// The event vocabulary is the exact table from Phase 1 section 8 — every
// entry there should have a matching literal here so nothing gets added
// to the spec without a corresponding emit() call site, and vice versa.
export type NotificationEventType =
  | "job_assigned"
  | "technician_en_route"
  | "technician_arrived"
  | "quotation_ready"
  | "quotation_decided"
  | "maintenance_due"
  | "invoice_ready"
  | "job_completed"
  | "dispute_opened"
  | "contractor_verification_changed";

interface EmitParams {
  userId: string;
  eventType: NotificationEventType;
  payload: Record<string, unknown>;
}

// Channel adapter interface — same pattern as PaymentProvider (Phase 1
// section 11.2 established this pattern first; applied here too). v1
// ships EmailChannelAdapter only; SMS/WhatsApp/push in v1.1 are new files
// implementing this same interface, per Phase 1 section 8 and Phase 3's
// "coming soon" tag in Settings rather than hiding the option.
interface ChannelAdapter {
  readonly channel: NotificationChannel;
  send(to: string, eventType: NotificationEventType, payload: Record<string, unknown>): Promise<void>;
}

class EmailChannelAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  async send(to: string, eventType: NotificationEventType, payload: Record<string, unknown>) {
    // Real implementation sends via a transactional email provider (e.g.
    // Postmark/SES). Logging here keeps this vertical slice runnable
    // without external email credentials.
    console.log(`[email → ${to}] ${eventType}`, payload);
  }
}

@Injectable()
export class NotificationsService {
  private readonly emailAdapter = new EmailChannelAdapter();

  constructor(private readonly prisma: PrismaService) {}

  /** Called from other modules' TODO(Phase 6 cont'd) markers. */
  async emit({ userId, eventType, payload }: EmitParams) {
    const notification = await this.prisma.notification.create({
      data: { userId, eventType, channel: "email", payload },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await this.emailAdapter.send(user.email, eventType, payload);
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { sentAt: new Date() },
      });
    }

    return notification;
  }

  async list(ctx: RequestContext) {
    return this.prisma.notification.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async markRead(ctx: RequestContext, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId: ctx.userId },
      data: { readAt: new Date() },
    });
  }
}

@Controller("notifications")
@UseGuards(ClerkAuthGuard, ContextGuard)
class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.notifications.list(ctx);
  }

  @Patch(":id/read")
  markRead(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.notifications.markRead(ctx, id);
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, ContextGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}
