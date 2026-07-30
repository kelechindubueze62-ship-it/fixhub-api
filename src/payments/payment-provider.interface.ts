// Implements the abstraction locked in Phase 1 section 11.2 and described
// in Phase 2 section 2.5: v1 ships Stripe only, but every call site talks
// to this interface, not to Stripe directly, so Paystack/Flutterwave in
// v1.1 are new files implementing this same contract — not a rewrite of
// InvoicesService or the /invoices/:id/pay endpoint.

export interface CreateChargeParams {
  amountMinorUnits: number;
  currency: string;
  invoiceId: string;
  /** Where to send the payer after completing payment on the provider's hosted page. */
  successUrl: string;
  cancelUrl: string;
}

export interface CreateChargeResult {
  /** Opaque to callers — stored as payments.provider_reference. */
  providerReference: string;
  /** URL to redirect the payer to (hosted checkout). */
  redirectUrl: string;
}

export interface RefundParams {
  providerReference: string;
  amountMinorUnits?: number; // omit for full refund
}

export interface PayoutParams {
  contractorPayoutAccountRef: string; // opaque provider-specific account id
  amountMinorUnits: number;
  currency: string;
}

export interface PaymentProvider {
  readonly name: "stripe" | "paystack" | "flutterwave";
  createCharge(params: CreateChargeParams): Promise<CreateChargeResult>;
  refund(params: RefundParams): Promise<void>;
  payout(params: PayoutParams): Promise<{ providerReference: string }>;
  /** Verifies an inbound webhook signature and returns a normalized event. */
  parseWebhookEvent(rawBody: Buffer, signatureHeader: string): NormalizedPaymentEvent;
}

export type NormalizedPaymentEvent =
  | { type: "charge.succeeded"; providerReference: string }
  | { type: "charge.failed"; providerReference: string }
  | { type: "charge.refunded"; providerReference: string };

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
