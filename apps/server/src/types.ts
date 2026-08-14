import type { User } from "./db.js";
import type { SessionKind } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    // How the caller's session was minted — set alongside `user` by
    // app.authenticate. A 'device' session belongs to a linked display rather
    // than to someone at a keyboard, and requireAdmin refuses it.
    sessionKind?: SessionKind;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
