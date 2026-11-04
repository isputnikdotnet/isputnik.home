// The face engine's place in the apps platform (docs/face-engine-plan.md): its
// gateway, for the admin's window only — events and the log tail on Overview ›
// Logs, and health for the Dashboard's probe. Detection never goes through here:
// the scanner calls the engine itself (detector.ts), and the registry's
// browserPaths keep every other path under /faces a 404.
import type { FastifyInstance } from "fastify";
import { registerAppGateway } from "../../../apps/gateway.js";
import { resolveAppSecret } from "../../../apps/pairing.js";
import { appConfigured, appDefinition } from "../../../apps/registry.js";
import { faceDetector } from "./detector.js";

const FACES = appDefinition("faces");

export interface FacesGatewayOptions {
  /** Overrides for tests, which run without FACES_URL and point at a stand-in. */
  upstream?: string;
  secret?: string;
}

export async function facesGatewayPlugin(app: FastifyInstance, opts: FacesGatewayOptions = {}) {
  const target = () => ({
    upstream: opts.upstream ?? resolveAppSecret("faces").upstream,
    secret: opts.secret ?? resolveAppSecret("faces").secret
  });
  await registerAppGateway(app, {
    app: FACES,
    upstream: () => target().upstream,
    secret: () => target().secret,
    available: () => appConfigured(FACES, target().upstream, target().secret).enabled,
    hasPages: false
  });

  // How faces are found right now — the container, this process, or nothing —
  // for the Gallery's face settings. Probes the container, so asked on demand.
  app.get("/api/library/gallery/faces/engine", { preHandler: app.requireAdmin }, async () => faceDetector().status());
}
