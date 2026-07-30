import * as Sentry from "@sentry/node";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";

// No-op unless SENTRY_DSN is set, so local dev and the sandboxed CI run
// don't require a real Sentry project to boot cleanly.
export function initSentry() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1, environment: process.env.NODE_ENV });
}

// Only reports 5xx (our bugs) to Sentry — 4xx (bad requests, failed auth,
// state-machine conflicts) are expected application behavior, not
// incidents, and reporting them would bury real errors in noise.
@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("UnhandledException");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof HttpException ? exception.getResponse() : "Internal server error";

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : exception);
      if (process.env.SENTRY_DSN) Sentry.captureException(exception);
    }

    response.status(status).json(
      typeof message === "string" ? { error: { message, status } } : { error: { ...message, status } }
    );
  }
}
