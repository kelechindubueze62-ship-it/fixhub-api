import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Request } from "express";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export interface AuthedRequest extends Request {
  clerkUserId: string;
}

// Verifies the bearer token issued by Clerk (frontend calls this "sub").
// This guard establishes identity ONLY — it does not resolve organization
// membership or role. That happens in RequestContextService, kept
// deliberately separate so identity verification and authorization are
// two distinct, independently testable concerns (Phase 4 section 1).
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = authHeader.slice("Bearer ".length);

    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY!,
      });
      req.clerkUserId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}

export { clerkClient };
