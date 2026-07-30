import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from "@nestjs/common";
import { RequestContextService } from "./request-context.service";
import type { AuthedRequest } from "./clerk-auth.guard";
import type { RequestContext } from "./types";

export interface ContextedRequest extends AuthedRequest {
  context: RequestContext;
}

// Runs after ClerkAuthGuard. Reads the active tenant from the X-Org-Id or
// X-Contractor-Id header (mirrors the frontend's fh_active_tenant cookie —
// see Phase 4 section 4) and resolves it into a full RequestContext that
// controllers can trust for the rest of the request.
@Injectable()
export class ContextGuard implements CanActivate {
  constructor(private readonly contextService: RequestContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ContextedRequest>();
    const requestedTenantId =
      (req.headers["x-org-id"] as string) ?? (req.headers["x-contractor-id"] as string) ?? undefined;

    req.context = await this.contextService.resolve(req.clerkUserId, requestedTenantId);
    return true;
  }
}

/** Usage: `myEndpoint(@Ctx() ctx: RequestContext)` in any controller. */
export const Ctx = createParamDecorator((_data: unknown, exec: ExecutionContext): RequestContext => {
  const req = exec.switchToHttp().getRequest<ContextedRequest>();
  return req.context;
});
