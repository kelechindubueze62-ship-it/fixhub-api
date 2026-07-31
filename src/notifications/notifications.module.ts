import { Body, Controller, Get, Injectable, Module, Param, Patch, UseGuards } from "@nestjs/common";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { NotificationChannel, Prisma } from "@prisma/client";

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

interface ChannelAdapter {
  readonly channel: NotificationChannel;
  send(to: string, eventType: NotificationEventType, payload: Record<string, unknown>): Promise<void>;
}

class EmailChannelAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  async send(to: string, eventType: NotificationEventType, payload: Record<string, unknown>) {
    console.log(`[email → ${to}] ${eventType}`, payload);
  }
}

@Injectable()
export class NotificationsService {
  private readonly emailAdapter = new EmailChannelAdapter();

  constructor(private readonly prisma: PrismaService) {}

  async emit({ userId, eventType, payload }: EmitParams) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        eventType,
        channel: "email",
        payload: payload as Prisma.InputJsonValue,
      },
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
