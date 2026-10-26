// Apps — the containers beside this server, as one system (docs/apps-platform-plan.md).
// A product module: it knows which containers this release can talk to
// (registry.ts), the gateway they are reached through (gateway.ts) and how each
// one stands (status.ts). Each container's own module registers its gateway with
// the hooks it needs — games: modules/games — so nothing here is game-specific.
import type { FastifyInstance } from "fastify";
import { appStatus } from "./status.js";
import { APPS, appSettings, type AppId } from "./registry.js";

export interface AppsPluginOptions {
  /** Overrides for tests, which run without the environment and point at stand-ins. */
  settings?: Partial<Record<AppId, { upstream: string; secret: string }>>;
}

export async function appsPlugin(app: FastifyInstance, opts: AppsPluginOptions = {}) {
  // Control panel → Apps → Installed: every container this release knows, set up
  // or not. Read-only: where a container is and its secret are the install's
  // environment (pairing is a later phase of the plan).
  app.get("/api/apps/admin/status", { preHandler: app.requireAdmin }, async (request) => ({
    apps: await Promise.all(
      APPS.map((definition) => {
        const { upstream, secret } = opts.settings?.[definition.id] ?? appSettings(definition.id);
        return appStatus(definition, upstream, secret, request);
      })
    )
  }));
}
