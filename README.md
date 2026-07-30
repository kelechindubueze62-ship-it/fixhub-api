# FixHub — API

## Fix round (post-assessment)

Following an honest end-of-Phase-7 assessment, these were addressed directly rather than left as backlog items:

| Problem | Fix |
|---|---|
| No `ContractorCompanyMembership` model — `contractor_admin` wasn't a real, distinguishable identity | Added the model (mirrors `Membership`), updated `RequestContextService`/`UserIdentityDto` to resolve it |
| `POST /organizations` and `POST /contractor-companies` were never implemented, despite Phase 4's signup flow assuming them | Added `src/onboarding/onboarding.module.ts` |
| Nothing ever created a `users` row on signup | Added `src/clerk-webhook/clerk-webhook.module.ts` (Clerk `user.created`/`updated`/`deleted` sync) |
| No rate limiting | Global `ThrottlerModule` + a stricter per-route limit on `POST /jobs`; a purpose-built sliding-window limiter on the `send_message` websocket handler, since the HTTP-shaped throttler guard doesn't fit a socket transport |
| No cursor pagination, despite Phase 2 section 4.1 specifying it | Implemented on `/jobs` and `/buildings` (the two hottest list endpoints) — `{ items, nextCursor }` response shape |
| Preventive maintenance was never wired — nothing read `next_due_date` | Added `src/maintenance-scheduler/maintenance-scheduler.module.ts`, a daily job that generates due jobs and rolls schedules forward |
| Emergency broadcast was a TODO | `JobsService.create` now actually notifies every available, skill-matched, in-range technician on an emergency job |
| No dependency scanning | Added `.github/dependabot.yml` (npm + Docker + Actions, both projects) |
| No error monitoring | Added Sentry wiring (backend: `src/sentry.ts` + global exception filter; frontend: `sentry.client/server.config.ts`) — both are true no-ops unless a DSN is configured, so an unconfigured deploy behaves identically to before |

**Still open, and why:** a true concurrency integration test against real Postgres couldn't be run in this sandbox — the Prisma engine binary download is blocked by the sandbox's network allowlist (`binaries.prisma.sh` isn't reachable), which is a sandbox limitation, not a code issue. The existing `contractors.module.spec.ts` test simulates the compare-and-swap correctly at the application-logic level; running it against real Postgres in `api-ci.yml` (which already spins up a Postgres service container) is the natural next step once this is pushed to GitHub, where network access is unrestricted.

---


NestJS + Prisma implementation of the Phase 2 schema/API design and Phase 4 auth model.

## What's in this pass

| Piece | Status |
|---|---|
| **Prisma schema** (`prisma/schema.prisma`) | Complete — every entity from Phase 2 section 2, field-for-field |
| **Auth** (`src/auth/*`) | Complete: `ClerkAuthGuard` verifies identity, `RequestContextService` resolves role/tenant server-side on every request (Phase 4 section 3.1), `GET /v1/me` returns the exact shape the frontend's `resolve-context.ts` expects |
| **Buildings** (`src/buildings`) | Full CRUD, tenant + `building_scope` enforced, 404-not-403 on out-of-scope access so we don't leak existence of other tenants' data |
| **Assets + Maintenance Schedules** (`src/assets`) | Full CRUD, visibility inherited from the parent building rather than re-specified |
| **Jobs** (`src/jobs`) | Create + list + get + **status transition state machine** — `ALLOWED_TRANSITIONS` is a direct transcription of Phase 2 section 4.3; illegal jumps return 409, not a silent no-op |
| **Quotations** (`src/quotations`) | Submit (contractor), approve/decline (owner/facility_manager) — approval enforces the **exact facility-manager spend-limit guard sketched in Phase 4 section 3.3**: over their `spend_approval_limit`, the request is rejected and needs an owner instead |
| **Payments** (`src/payments`) | `PaymentProvider` interface per Phase 1 section 11.2 + Phase 2 section 2.5, with a working `StripeProvider` implementation (Checkout session + webhook signature verification + idempotent payment reconciliation via the unique `provider_reference` constraint) |
| **Contractors/Technicians** (`src/contractors`) | Technician invite (Phase 4 section 2.3 — invite-only, never self-serve), status/location updates, the ranked assignment shortlist and admin-confirm endpoint (Phase 1 section 11.3 hybrid model), and the **emergency broadcast-and-claim** with real concurrency safety via a conditional `updateMany` (first successful write wins — no application-level locking needed) |
| **Admin** (`src/admin`) | Users, contractor verification (writes to `audit_log` per Phase 4 section 6), cross-tenant job/dispute views, platform analytics overview |
| **Notifications** (`src/notifications`) | Event vocabulary from Phase 1 section 8, `ChannelAdapter` interface (same pattern as `PaymentProvider`), working `EmailChannelAdapter` (console-logs in this slice — swap for a real provider), wired into the `job_assigned` and `quotation_ready` trigger points that were previously `TODO`s |
| **Messages** (`src/messages`) | Real-time job-scoped chat over a Socket.IO gateway, same visibility rule as the REST endpoints (join/send silently no-ops if you can't see the job, rather than erroring and confirming it exists) |
| **Seed script** (`prisma/seed.ts`) | Full service category/subcategory taxonomy from Phase 1 section 7 |

**Phase 6 vertical slice is now feature-complete against the Phase 2 API surface**, with one known gap — see below.

## Running it

```bash
npm install
cp .env.example .env
# point DATABASE_URL at a real Postgres instance
npx prisma migrate dev --name init
npx prisma db seed
npm run start:dev
```

`GET http://localhost:4000/v1/me` with a valid Clerk bearer token should return a `UserIdentityDto` — this is the endpoint the frontend's `fixhub-web/.env.local`'s `FIXHUB_API_BASE_URL` should point at once you flip the `TODO(Phase 6)` in `(app)/layout.tsx` from `MOCK_IDENTITY` to `resolveContext()`.

## Design decisions worth knowing about

- **Identity vs. authorization are two separate guards.** `ClerkAuthGuard` only proves who's calling; `ContextGuard`/`RequestContextService` separately resolves what they're allowed to do *in this specific tenant*. Keeping these apart means a compromised or stale JWT claim can never grant tenant access — role is always looked up fresh.
- **The job status state machine lives in exactly one place** (`ALLOWED_TRANSITIONS` in `jobs.module.ts`). No controller or service anywhere else is allowed to write to `job.status` directly — this is the enforcement point the whole product's trust model (Phase 2 section 4.3) depends on.
- **404 over 403 for out-of-scope resources.** Consistently applied in Buildings, Assets, and Jobs — confirming a resource *exists* but you can't see it is itself a data leak in a multi-tenant marketplace.
- **Payments never call Stripe directly from a controller.** `InvoicesService`/`WebhooksController` depend on the `PaymentProvider` interface (injected via the `PAYMENT_PROVIDER` token), and `StripeProvider` is the only file that imports the `stripe` package. Adding Paystack in v1.1 means a new file implementing the same interface, not touching `InvoicesService`.
- **The Stripe webhook has no auth guard.** It can't — Stripe calls it, not a logged-in user. Trust comes entirely from `parseWebhookEvent`'s signature verification against the raw request body, which is why `main.ts` registers `express.raw()` for that one path before Nest's JSON parser runs.

## Known gap worth your attention

**There is no `ContractorCompanyMembership` model.** Phase 4 section 3 defines a distinct `contractor_admin` role separate from `technician`, but Phase 2's schema only ever modeled `Technician` (always `role: technician`) against a `ContractorCompany` — there's no row representing "the person who administers this company" the way `Membership` does for organizations. This surfaced concretely in `admin.module.ts`'s `verifyContractorCompany`, which can't correctly notify a contractor admin because there's no way to look one up. Fixing it means adding a membership-style model mirroring `Membership`, analogous to how organizations work — flagging this now rather than working around it with a guess, since it also affects `RequestContextService`'s current shortcut of treating "has a Technician row" as the only contractor-side identity.

## Next in Phase 6

1. Add `ContractorCompanyMembership` (see gap above) and update `RequestContextService`/`ContractorMembershipDto` accordingly — this is the one piece worth doing before building more on top of the contractor side.
2. Wire the remaining `NotificationEventType`s (`technician_en_route`, `technician_arrived`, `maintenance_due`, `invoice_ready`, `job_completed`, `dispute_opened`) into their trigger points across Jobs/Payments/Admin.
3. A scheduled job (cron or queue) to auto-generate `Job` rows from due `MaintenanceSchedule` records — the preventive maintenance flow from Phase 1 section 6.5 needs this; nothing currently reads `next_due_date`.
4. Integration tests for the state machine (`jobs.module.ts`) and the emergency-claim concurrency path (`contractors.module.ts`) — the latter especially, since its correctness depends on the conditional `updateMany` behaving as expected under real concurrent load, which is worth verifying rather than assuming.
