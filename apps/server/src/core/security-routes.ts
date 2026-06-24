import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import { isValidCidr } from "./cidr.js";
import {
  listTrustedNetworks,
  addTrustedNetwork,
  removeTrustedNetwork,
  listBlockedIps,
  blockIp,
  unblockIp,
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
  IP_FAIL_THRESHOLD,
  IP_FAIL_WINDOW_MINUTES,
  IP_AUTOBLOCK_MINUTES
} from "./security.js";

const trustedSchema = z.object({
  cidr: z.string().trim().min(1).max(64),
  label: z.string().trim().max(60).optional()
});

const blockSchema = z.object({
  ip: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(120).optional()
});

// Admin management of the access-control layer: trusted networks (relaxed zone)
// and blocked source IPs (manual + the read-out of auto-blocks). Brute-force
// thresholds are fixed in code and surfaced read-only for the UI to explain.
export async function securityRoutes(app: FastifyInstance) {
  app.get("/api/security", { preHandler: app.requireAdmin }, async () => ({
    policy: {
      lockoutThreshold: LOCKOUT_THRESHOLD,
      lockoutMinutes: LOCKOUT_MINUTES,
      ipFailThreshold: IP_FAIL_THRESHOLD,
      ipFailWindowMinutes: IP_FAIL_WINDOW_MINUTES,
      ipAutoblockMinutes: IP_AUTOBLOCK_MINUTES
    },
    trustedNetworks: listTrustedNetworks().map((network) => ({
      id: network.id,
      cidr: network.cidr,
      label: network.label,
      createdAt: network.created_at
    })),
    blockedIps: listBlockedIps().map((entry) => ({
      ip: entry.ip_address,
      reason: entry.reason,
      auto: Boolean(entry.auto),
      createdAt: entry.created_at,
      expiresAt: entry.expires_at
    }))
  }));

  app.post("/api/security/trusted-networks", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(trustedSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid network", details: parsed.error });
      return;
    }
    if (!isValidCidr(parsed.data.cidr)) {
      reply.code(400).send({ error: "Enter a valid IP address or CIDR range (e.g. 192.168.1.0/24)." });
      return;
    }
    try {
      const id = addTrustedNetwork(parsed.data.cidr, parsed.data.label?.length ? parsed.data.label : null, request.user!.id);
      logActivity({
        event: "security.trusted_network_added",
        actorUserId: request.user!.id,
        detail: `Added trusted network ${parsed.data.cidr}.`,
        ipAddress: request.ip
      });
      reply.code(201).send({ id });
    } catch {
      reply.code(409).send({ error: "That network is already trusted." });
    }
  });

  app.delete("/api/security/trusted-networks/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!removeTrustedNetwork(id)) {
      reply.code(404).send({ error: "Trusted network not found" });
      return;
    }
    logActivity({
      event: "security.trusted_network_removed",
      actorUserId: request.user!.id,
      detail: "Removed a trusted network.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.post("/api/security/blocked-ips", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(blockSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid IP address", details: parsed.error });
      return;
    }
    // A block targets a single host — reject ranges (the store keys on exact IP).
    if (parsed.data.ip.includes("/") || !isValidCidr(parsed.data.ip)) {
      reply.code(400).send({ error: "Enter a single valid IP address." });
      return;
    }
    blockIp(parsed.data.ip, {
      reason: parsed.data.reason?.length ? parsed.data.reason : "Blocked by an administrator",
      auto: false,
      userId: request.user!.id
    });
    logActivity({
      event: "security.ip_blocked",
      actorUserId: request.user!.id,
      detail: `Blocked IP ${parsed.data.ip}.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ ok: true });
  });

  app.delete("/api/security/blocked-ips/:ip", { preHandler: app.requireAdmin }, async (request, reply) => {
    const ip = (request.params as { ip: string }).ip;
    if (!unblockIp(ip)) {
      reply.code(404).send({ error: "Blocked IP not found" });
      return;
    }
    logActivity({
      event: "security.ip_unblocked",
      actorUserId: request.user!.id,
      detail: `Unblocked IP ${ip}.`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });
}
