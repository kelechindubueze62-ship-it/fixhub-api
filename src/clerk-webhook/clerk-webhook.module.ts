import { Controller, Injectable, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Webhook } from "svix";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";

// Closes a real gap: nothing previously created a `users` row for a
// normal signup — onboarding.module.ts's createOrganization/
// createContractorCompany both assume the row already exists via
// findUniqueOrThrow. Clerk's `user.created`/`user.updated` webhooks are
// the actual source of truth for that row, same pattern as the Stripe
// webhook in payments.module.ts: no auth guard (Clerk calls this, not a
// logged-in user), trust comes entirely from signature verification.
interface ClerkUserWebhookEvent {
  type: "user.created" | "user.updated" | "user.deleted";
  data: {
    id: string;
    email_addresses: { email_address: string }[];
    first_name: string | null;
    last_name: string | null;
    image_url: string | null;
  };
}

@Injectable()
class ClerkWebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async handleUserEvent(event: ClerkUserWebhookEvent) {
    if (event.type === "user.deleted") {
      // Soft-handle: mark suspended rather than delete, to preserve
      // referential integrity with jobs/messages/audit_log this user
      // may have created.
      await this.prisma.user.updateMany({
        where: { clerkUserId: event.data.id },
        data: { status: "suspended" },
      });
      return;
    }

    const email = event.data.email_addresses[0]?.email_address;
    if (!email) return;

    const fullName = [event.data.first_name, event.data.last_name].filter(Boolean).join(" ") || email;

    await this.prisma.user.upsert({
      where: { clerkUserId: event.data.id },
      update: { email, fullName, avatarUrl: event.data.image_url ?? undefined },
      create: {
        clerkUserId: event.data.id,
        email,
        fullName,
        avatarUrl: event.data.image_url ?? undefined,
        status: "active",
      },
    });
  }
}

@Controller("webhooks")
class ClerkWebhookController {
  private readonly webhook = new Webhook(process.env.CLERK_WEBHOOK_SIGNING_SECRET!);

  constructor(private readonly clerkWebhookService: ClerkWebhookService) {}

  @Post("clerk")
  async handle(@Req() req: Request & { rawBody: Buffer }) {
    const event = this.webhook.verify(req.rawBody, {
      "svix-id": req.headers["svix-id"] as string,
      "svix-timestamp": req.headers["svix-timestamp"] as string,
      "svix-signature": req.headers["svix-signature"] as string,
    }) as ClerkUserWebhookEvent;

    await this.clerkWebhookService.handleUserEvent(event);
    return { received: true };
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [ClerkWebhookController],
  providers: [ClerkWebhookService],
})
export class ClerkWebhookModule {}
