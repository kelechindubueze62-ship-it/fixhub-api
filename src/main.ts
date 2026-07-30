import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import * as express from "express";
import { AppModule } from "./app.module";
import { initSentry, SentryExceptionFilter } from "./sentry";

async function bootstrap() {
  initSentry();
  const app = await NestFactory.create(AppModule, { rawBody: false });

  // Both webhook endpoints need the raw body for signature verification —
  // must be registered before Nest's default JSON body parser touches
  // these paths, or req.rawBody won't exist by the time the controller runs.
  for (const path of ["/v1/webhooks/stripe", "/v1/webhooks/clerk"]) {
    app.use(
      path,
      express.raw({ type: "application/json" }),
      (req: express.Request & { rawBody?: Buffer }, _res: express.Response, next: express.NextFunction) => {
        req.rawBody = req.body;
        next();
      }
    );
  }

  app.setGlobalPrefix("v1");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new SentryExceptionFilter());
  app.enableCors({ origin: process.env.WEB_APP_ORIGIN ?? "http://localhost:3000", credentials: true });
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
