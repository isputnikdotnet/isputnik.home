import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerAuthDecorators } from "./auth.js";
import { registerRoutes } from "./routes.js";

const app = fastify({
  logger: true,
  trustProxy: true
});

await app.register(cors, {
  origin: config.appUrl,
  credentials: true
});
await app.register(cookie);
await registerAuthDecorators(app);
await registerRoutes(app);

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Unexpected server error" });
});

await app.listen({ host: config.host, port: config.port });
