import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { ClerkAuthGuard } from "../auth/clerk-auth.guard";
import { ContextGuard, Ctx } from "../auth/context.guard";
import type { RequestContext } from "../auth/types";
import { PAYMENT_PROVIDER, PaymentProvider } from "./payment-provider.interface";
import { StripeProvider } from "./providers/stripe.provider";
import { Inject } from "@nestjs/common";

@Injectable()
class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider
  ) {}

  async list(ctx: RequestContext) {
    if (ctx.scope !== "organization") throw new ForbiddenException();
    return this.prisma.invoice.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      include: { job: true },
    });
  }

  async pay(ctx: RequestContext, invoiceId: string, appOrigin: string) {
    if (ctx.scope !== "organization") throw new ForbiddenException();

    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.organizationId !== ctx.organizationId) {
      throw new NotFoundException("Invoice not found");
    }
    if (invoice.status === "paid") {
      throw new ForbiddenException("Invoice already paid");
    }

    const charge = await this.paymentProvider.createCharge({
      amountMinorUnits: invoice.total,
      currency: invoice.currency,
      invoiceId: invoice.id,
      successUrl: `${appOrigin}/app/invoices/${invoice.id}?paid=1`,
      cancelUrl: `${appOrigin}/app/invoices/${invoice.id}`,
    });

    await this.prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        provider: this.paymentProvider.name,
        providerReference: charge.providerReference,
        amount: invoice.total,
        currency: invoice.currency,
        status: "pending",
      },
    });

    return { redirectUrl: charge.redirectUrl };
  }

  /**
   * Called by the webhook controller after signature verification.
   * Idempotent via the unique constraint on payments.provider_reference —
   * a Stripe retry of the same event is a harmless no-op update, not a
   * double-charge or duplicate row (Phase 2 section 4.4).
   */
  async markPaymentSucceeded(providerReference: string) {
    const payment = await this.prisma.payment.findUnique({ where: { providerReference } });
    if (!payment) return; // unknown reference — ignore rather than throw, webhook must 200

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: "succeeded", paidAt: new Date() },
      }),
      this.prisma.invoice.update({
        where: { id: payment.invoiceId },
        data: { status: "paid" },
      }),
    ]);
  }
}

@Controller("invoices")
@UseGuards(ClerkAuthGuard, ContextGuard)
class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.invoices.list(ctx);
  }

  @Post(":id/pay")
  pay(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return this.invoices.pay(ctx, id, process.env.WEB_APP_ORIGIN ?? "http://localhost:3000");
  }
}

// No auth guards — this endpoint is called by Stripe, not a logged-in
// user. Trust is established entirely by verifying the webhook signature
// inside parseWebhookEvent, not by anything in the request headers a
// caller could forge. Requires the raw request body — see main.ts, which
// registers express.raw() for this exact path before the JSON body
// parser runs.
@Controller("webhooks")
class WebhooksController {
  constructor(
    private readonly invoices: InvoicesService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider
  ) {}

  @Post("stripe")
  async handleStripe(@Req() req: Request & { rawBody: Buffer }) {
    const signature = req.headers["stripe-signature"] as string;
    const event = this.paymentProvider.parseWebhookEvent(req.rawBody, signature);

    if (event.type === "charge.succeeded") {
      await this.invoices.markPaymentSucceeded(event.providerReference);
    }
    // charge.failed / charge.refunded handling follows the same pattern —
    // omitted here to keep this vertical slice focused on the success path,
    // flagged as a follow-up rather than silently incomplete.

    return { received: true };
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [InvoicesController, WebhooksController],
  providers: [
    InvoicesService,
    ContextGuard,
    { provide: PAYMENT_PROVIDER, useClass: StripeProvider },
  ],
})
export class PaymentsModule {}
