import { Injectable, Module, UnauthorizedException } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { verifyToken } from "@clerk/backend";
import { PrismaModule, PrismaService } from "../prisma/prisma.module";
import { RequestContextService } from "../auth/request-context.service";
import { AuthModule } from "../auth/auth.module";
import type { RequestContext } from "../auth/types";

interface AuthedSocket extends Socket {
  data: { ctx?: RequestContext; messageTimestamps?: number[] };
}

// @nestjs/throttler's guard is HTTP-request-shaped; rather than force-fit
// it onto a websocket gateway, this is a small sliding-window counter per
// socket connection — same spam-guard intent as Phase 2 section 4.5's
// "POST /messages" rate limit, adapted to the transport actually in use.
const MESSAGE_RATE_LIMIT = 20; // messages
const MESSAGE_RATE_WINDOW_MS = 60_000;

function isRateLimited(client: AuthedSocket): boolean {
  const now = Date.now();
  const timestamps = (client.data.messageTimestamps ?? []).filter((t) => now - t < MESSAGE_RATE_WINDOW_MS);
  timestamps.push(now);
  client.data.messageTimestamps = timestamps;
  return timestamps.length > MESSAGE_RATE_LIMIT;
}

// Chat is always scoped to a job (Phase 2 section 2.6 — Message.jobId is
// required, there's no free-floating DM). Each job gets its own socket.io
// room (`job:{id}`); joining requires the same visibility check every
// REST endpoint uses, so a technician from an unrelated contractor can't
// listen in on someone else's job thread just by guessing a job id.
@Injectable()
@WebSocketGateway({ cors: { origin: process.env.WEB_APP_ORIGIN ?? "http://localhost:3000", credentials: true } })
export class MessagesGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: RequestContextService
  ) {}

  async handleConnection(client: AuthedSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new UnauthorizedException();
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
      const requestedTenantId = client.handshake.auth?.tenantId as string | undefined;
      client.data.ctx = await this.contextService.resolve(payload.sub, requestedTenantId);
    } catch {
      client.disconnect(true);
    }
  }

  private async assertJobVisible(ctx: RequestContext, jobId: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return false;
    if (ctx.scope === "global") return true;
    if (ctx.scope === "organization" && ctx.organizationId === job.organizationId) return true;
    if (ctx.scope === "contractor" && ctx.contractorCompanyId === job.contractorCompanyId) return true;
    return false;
  }

  @SubscribeMessage("join_job")
  async onJoinJob(@ConnectedSocket() client: AuthedSocket, @MessageBody() data: { jobId: string }) {
    if (!client.data.ctx) return client.disconnect(true);
    const visible = await this.assertJobVisible(client.data.ctx, data.jobId);
    if (!visible) return; // silently refuse to join rather than error — same 404-not-403 posture as REST

    await client.join(`job:${data.jobId}`);
  }

  @SubscribeMessage("send_message")
  async onSendMessage(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { jobId: string; body: string }
  ) {
    if (!client.data.ctx) return client.disconnect(true);
    if (isRateLimited(client)) {
      client.emit("rate_limited", { retryAfterMs: MESSAGE_RATE_WINDOW_MS });
      return;
    }
    const visible = await this.assertJobVisible(client.data.ctx, data.jobId);
    if (!visible) return;

    const message = await this.prisma.message.create({
      data: { jobId: data.jobId, senderId: client.data.ctx.userId, body: data.body },
    });

    this.server.to(`job:${data.jobId}`).emit("new_message", message);
  }
}

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [MessagesGateway],
})
export class MessagesModule {}
