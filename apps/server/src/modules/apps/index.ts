// Apps — the containers beside this server, as one system (docs/apps-platform-plan.md).
// A product module: it knows which containers this release can talk to
// (registry.ts), the gateway they are reached through (gateway.ts), who may use
// each one and from where (access.ts), and how each one stands (status.ts). Each
// container's own module registers its gateway with the hooks it needs — games:
// modules/games — so nothing here is game-specific.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { appStatus } from "./status.js";
import { APP_GRANT_ROLES, grantAppRole, listAppAccess, revokeAppRole, rulesFor, setEveryoneAppRole, setRule } from "./access.js";
import { forgetPairing, normalizeAddress, pairApp, resolveAppSecret, saveAppAddress, type AddressSource, type SecretSource } from "./pairing.js";
import { APPS, NETWORK_RULES, urlProblem, type AppDefinition, type AppId } from "./registry.js";

export interface AppsPluginOptions {
  /** Overrides for tests, which run without the environment and point at stand-ins. */
  settings?: Partial<Record<AppId, { upstream: string; secret: string }>>;
}

/** "" clears the address. */
const addressSchema = z.object({ url: z.string().max(500) });
const everyoneSchema =z.object({ role: z.enum(["member", "manager"]).nullable() });
const grantSchema = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64),
  role: z.enum(APP_GRANT_ROLES)
});
const rulesSchema = z.record(z.string().min(1).max(40), z.enum(NETWORK_RULES));

export async function appsPlugin(app: FastifyInstance, opts: AppsPluginOptions = {}) {
  /** The address and secret in force: a test's stand-in, else the install's. */
  const settingsFor = (id: AppId) => {
    const override = opts.settings?.[id];
    if (override) {
      return {
        ...override,
        source: (override.secret ? "environment" : "none") as SecretSource,
        urlSource: (override.upstream ? "environment" : "none") as AddressSource
      };
    }
    return resolveAppSecret(id);
  };

  // Overview › Dashboard and Settings › Apps: every container this release
  // knows, set up or not. Its address and its secret are each the environment's,
  // or the ones saved and paired below.
  app.get("/api/apps/admin/status", { preHandler: app.requireAdmin }, async (request) => ({
    apps: await Promise.all(
      APPS.map((definition) => {
        const { upstream, secret, source, urlSource } = settingsFor(definition.id);
        return appStatus(definition, upstream, secret, request, source, urlSource);
      })
    )
  }));

  // ── Settings › Apps: where the container is ────────────────────────────────

  // Saved here, the address needs no edit to this container's template and no
  // restart: the gateway looks it up on each request. Refused while the
  // environment sets one, which wins — as for the secret.
  app.put("/api/apps/admin/address/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    const parsed = parseBody(addressSchema, request.body);
    if ("error" in parsed) return reply.code(400).send(parsed.error);
    if (settingsFor(definition.id).urlSource === "environment") {
      return reply.code(409).send({ error: `${definition.urlVariable} is set on this container, and it wins over an address saved here. Remove it to set the address here instead.` });
    }
    const address = normalizeAddress(parsed.data.url);
    const problem = address ? urlProblem(definition, address) : null;
    if (problem) return reply.code(400).send({ error: problem });
    saveAppAddress(definition.id, address, request.user!.id);
    note(request, definition, "app.address", address ? `Set where ${definition.id} answers: ${address}.` : `Cleared the address of ${definition.id}; it stays off until it has one.`);
    return { url: address || null };
  });

  // ── Settings › Apps: pairing ───────────────────────────────────────────────

  // A new secret, shown once. Refused while the environment sets one: that one
  // wins, and a second the owner would paste somewhere would only mislead.
  app.post("/api/apps/admin/pairing/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    if (settingsFor(definition.id).source === "environment") {
      return reply.code(409).send({ error: `${definition.secretVariable} is set on this container, and it wins over a paired secret. Remove it to pair here instead.` });
    }
    const replacing = settingsFor(definition.id).source === "paired";
    const secret = pairApp(definition.id, request.user!.id);
    note(request, definition, replacing ? "app.pairing.rotated" : "app.pairing.created",
      replacing ? `Replaced the secret ${definition.id} is paired with.` : `Paired ${definition.id} with a new secret.`);
    return reply.code(201).send({ secret, variable: definition.containerSecretVariable });
  });

  app.delete("/api/apps/admin/pairing/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    if (forgetPairing(definition.id)) note(request, definition, "app.pairing.forgotten", `Forgot the secret ${definition.id} was paired with; it stays off until paired again.`);
    return { forgotten: true };
  });

  // ── Security › App access ────────────────────────────────────────────────────────

  /** The container a route names, or a 404 already sent. */
  const named = (request: FastifyRequest, reply: FastifyReply): AppDefinition | null => {
    const found = APPS.find((definition) => definition.id === (request.params as { id: string }).id);
    if (!found) void reply.code(404).send({ error: "No such app" });
    return found ?? null;
  };

  const accessAnswer = (definition: AppDefinition) => {
    const access = listAppAccess(definition.id);
    const rules = rulesFor(definition);
    return {
      app: definition.id,
      everyone: access.everyone,
      grants: access.grants,
      capabilities: definition.capabilities.map((cap) => ({ id: cap.id, rule: rules[cap.id], defaultRule: cap.defaultRule }))
    };
  };

  const note = (request: FastifyRequest, definition: AppDefinition, event: string, detail: string) =>
    logActivity({ event, actorUserId: request.user!.id, targetType: "app", targetId: definition.id, detail, ipAddress: request.ip });

  app.get("/api/apps/admin/access/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    return accessAnswer(definition);
  });

  app.put("/api/apps/admin/access/:id/everyone", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    const parsed = parseBody(everyoneSchema, request.body);
    if ("error" in parsed) return reply.code(400).send(parsed.error);
    setEveryoneAppRole(definition.id, parsed.data.role, request.user!.id);
    note(request, definition, "app.access.everyone", parsed.data.role
      ? `Set everyone's role in ${definition.id} to "${parsed.data.role}".`
      : `Took ${definition.id} away from everyone but the people and groups granted it.`);
    return accessAnswer(definition);
  });

  app.post("/api/apps/admin/access/:id/grants", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    const parsed = parseBody(grantSchema, request.body);
    if ("error" in parsed) return reply.code(400).send(parsed.error);
    const { subjectType, subjectId, role } = parsed.data;
    const exists = subjectType === "user"
      ? db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(subjectId)
      : db.prepare("SELECT id FROM user_groups WHERE id = ?").get(subjectId);
    if (!exists) return reply.code(404).send({ error: subjectType === "user" ? "User not found." : "Group not found." });
    grantAppRole(definition.id, subjectType, subjectId, role, request.user!.id);
    note(request, definition, "app.access.granted", `Granted ${subjectType} ${subjectId} the "${role}" role in ${definition.id}.`);
    return accessAnswer(definition);
  });

  app.delete("/api/apps/admin/access/:id/grants/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    const { subjectType, subjectId } = request.params as { subjectType: string; subjectId: string };
    if (subjectType !== "user" && subjectType !== "group") return reply.code(400).send({ error: "Invalid subject" });
    if (revokeAppRole(definition.id, subjectType, subjectId, request.user!.id)) {
      note(request, definition, "app.access.revoked", `Removed ${subjectType} ${subjectId}'s role in ${definition.id}.`);
    }
    return accessAnswer(definition);
  });

  app.put("/api/apps/admin/access/:id/rules", { preHandler: app.requireAdmin }, async (request, reply) => {
    const definition = named(request, reply);
    if (!definition) return reply;
    const parsed = parseBody(rulesSchema, request.body);
    if ("error" in parsed) return reply.code(400).send(parsed.error);
    for (const [capabilityId, rule] of Object.entries(parsed.data)) {
      if (!setRule(definition, capabilityId, rule, request.user!.id)) {
        return reply.code(400).send({ error: `Unknown capability "${capabilityId}"` });
      }
      note(request, definition, "app.access.rule", `Set ${definition.id}'s "${capabilityId}" to be used from: ${rule}.`);
    }
    return accessAnswer(definition);
  });
}
