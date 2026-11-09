import type { User } from "./db.js";
import type { SessionKind } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    // How the caller's session was minted — set alongside `user` by
    // app.authenticate. A 'device' session belongs to a linked display rather
    // than to someone at a keyboard, and requireAdmin refuses it.
    sessionKind?: SessionKind;
    // The session row's id and the viewing profile it wears (modules/profiles;
    // null is the account itself), set alongside `user` by app.authenticate.
    sessionId?: string;
    profileId?: string | null;
    // Set while an admin previews the app as a member (core/preview.ts): `user`
    // is then that member, and this is the admin looking.
    previewBy?: { id: string; displayName: string };
  }

  interface FastifyContextConfig {
    // A POST that only reads (a catalogue query with a filter body, a bulk
    // lookup): allowed during an admin's read-only "Preview as …" (core/preview.ts).
    previewSafe?: boolean;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
