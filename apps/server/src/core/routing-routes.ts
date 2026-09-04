import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import {
  ROUTING_SETTINGS_KEY,
  getRoutingSettings,
  getStoredRoutingKeyRaw,
  isRoutingConfigured,
  testRouting,
  type RoutingSettings
} from "./routing.js";
import { sealSecret, ensureSealed } from "./mfa.js";

const routingSchema = z.object({
  // Omitted/blank on save = keep the stored key; never echoed back to the client.
  apiKey: z.string().max(512).optional(),
  // The only way to say "forget it" — blank means keep, so turning routing back
  // off (and stopping any coordinates leaving the house) needs saying out loud.
  clearApiKey: z.boolean().optional(),
  // Blank = the public OpenRouteService. An operator pointing this at their own
  // container is the reason it exists; it is never taken from a member.
  endpoint: z.union([z.literal(""), z.url().max(500)])
});

/** Strip the secret before it leaves the server; report only that one is stored. */
function publicRouting(settings: RoutingSettings) {
  return { endpoint: settings.endpoint, hasApiKey: Boolean(settings.apiKey) };
}

export async function routingPlugin(app: FastifyInstance) {
  app.get("/api/config/routing", { preHandler: app.requireAdmin }, async () => ({
    routing: publicRouting(getRoutingSettings()),
    configured: isRoutingConfigured()
  }));

  app.put("/api/config/routing", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(routingSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid routing settings", details: parsed.error });
    }

    const next: RoutingSettings = {
      // Same keep-path contract as the SMTP password and the AbuseIPDB key: a
      // fresh key is sealed here, blank keeps the RAW stored value so a
      // transiently unreadable seal key can't wipe it.
      apiKey: parsed.data.clearApiKey
        ? ""
        : parsed.data.apiKey ? sealSecret(parsed.data.apiKey) : ensureSealed(getStoredRoutingKeyRaw()),
      endpoint: parsed.data.endpoint
    };

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(ROUTING_SETTINGS_KEY, JSON.stringify(next), request.user!.id);

    logActivity({
      event: "config.routing_updated",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: ROUTING_SETTINGS_KEY,
      detail: `Updated map routing (${next.apiKey ? "key set" : "no key"}, ${next.endpoint || "openrouteservice.org"}).`,
      ipAddress: request.ip
    });

    // getRoutingSettings re-reads so `configured` reflects what was stored, not
    // what was posted.
    return reply.send({ routing: publicRouting(getRoutingSettings()), configured: isRoutingConfigured() });
  });

  // One real route request against the saved key, so an admin finds out here
  // rather than by wondering why their story still draws straight lines.
  app.post("/api/config/routing/test", { preHandler: app.requireAdmin }, async (request, reply) => {
    const result = await testRouting();
    logActivity({
      event: "config.routing_test",
      actorUserId: request.user!.id,
      targetType: "setting",
      targetId: ROUTING_SETTINGS_KEY,
      detail: result.ok ? "Routing test succeeded." : `Routing test failed: ${result.error}`,
      ipAddress: request.ip
    });
    if (!result.ok) return reply.code(502).send({ error: result.error });
    return reply.send({ ok: true });
  });
}
