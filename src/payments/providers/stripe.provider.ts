import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import type {
  CreateChargeParams,
  CreateChargeResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  PayoutParams,
  RefundParams,
} from "../payment-provider.interface";

// The only file in the codebase that imports the `stripe` package. If
// Paystack lands in v1.1 per Phase 1 section 11.2, it gets its own file
// here implementing the same PaymentProvider interface — nothing else
// changes.
@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" });
  }

  async createCharge(params: CreateChargeParams): Promise<CreateChargeResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            unit_amount: params.amountMinorUnits,
            product_data: { name: `FixHub invoice ${params.invoiceId}` },
          },
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: { invoiceId: params.invoiceId },
    });

    return { providerReference: session.id, redirectUrl: session.url! };
  }

  async refund(params: RefundParams): Promise<void> {
    await this.stripe.refunds.create({
      payment_intent: params.providerReference,
      amount: params.amountMinorUnits,
    });
  }

  async payout(params: PayoutParams): Promise<{ providerReference: string }> {
    // Stripe Connect transfer — contractor_companies.payout_account holds
    // the connected account id (Phase 2 section 2.5).
    const transfer = await this.stripe.transfers.create({
      amount: params.amountMinorUnits,
      currency: params.currency.toLowerCase(),
      destination: params.contractorPayoutAccountRef,
    });
    return { providerReference: transfer.id };
  }

  parseWebhookEvent(rawBody: Buffer, signatureHeader: string): NormalizedPaymentEvent {
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      process.env.STRIPE_WEBHOOK_SECRET!
    );

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        return { type: "charge.succeeded", providerReference: session.id };
      }
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        return { type: "charge.refunded", providerReference: charge.payment_intent as string };
      }
      default:
        // Unrecognized event types are treated as a no-op failure signal
        // rather than thrown, so Stripe doesn't retry-storm us for event
        // types we intentionally don't handle yet.
        return { type: "charge.failed", providerReference: "unknown" };
    }
  }
}
