import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../db.js";
import { parseBody } from "./shared.js";
import { isValidCidr } from "./cidr.js";
import {
  listTrustedNetworks,
  addTrustedNetwork,
  removeTrustedNetwork,
  listBlockedIps,
  blockIp,
  unblockIp,
  makeIpBlockPermanent,
  getSecurityPolicy,
  setSecurityPolicy,
  getTrustProxyHops,
  wasForwardedHeaderSeen,
  seedKnownLoginNetworks,
  getStoredAbuseIpdbKeyRaw,
  type SecurityPolicy
} from "./security.js";
import { getPasswordPolicy, setPasswordPolicy } from "./password-policy.js";
import { checkIpReputation, getCachedReputation } from "./ip-reputation.js";
import { isMailConfigured } from "./mail.js";

const trustedSchema = z.object({
  cidr: z.string().trim().min(1).max(64),
  label: z.string().trim().max(60).optional()
});

const blockSchema = z.object({
  ip: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(120).optional()
});

const policySchema = z.object({
  lockoutThreshold: z.number().int().min(1).max(100),
  lockoutMinutes: z.number().int().min(1).max(1440),
  ipFailThreshold: z.number().int().min(1).max(10000),
  ipFailWindowMinutes: z.number().int().min(1).max(1440),
  ipAutoblockMinutes: z.number().int().min(1).max(10080),
  alertNewIpSignIn: z.boolean(),
  deviceLinkScope: z.enum(["local", "any"]),
  requireMfaOutside: z.boolean(),
  // Omitted/blank on save = keep the stored key; never echoed back (like the SMTP
  // password). Other policy cards PATCH the whole blob without it, so it must be
  // optional or a threshold save would wipe the key. `clearAbuseIpdbKey` is the
  // explicit "remove it" signal (blank alone means keep, so there was no other way).
  abuseIpdbKey: z.string().trim().max(120).optional(),
  clearAbuseIpdbKey: z.boolean().optional(),
  reputationAutoEscalate: z.boolean(),
  reputationEscalateThreshold: z.number().int().min(50).max(100),
  trustedDeletesOnly: z.boolean()
});

const passwordPolicySchema = z.object({
  minLength: z.number().int().min(8).max(128),
  requireComplexity: z.boolean()
});

// Admin management of the access-control layer: trusted networks (relaxed zone)
// and blocked source IPs (manual + the read-out of auto-blocks). Brute-force
// thresholds are fixed in code and surfaced read-only for the UI to explain.

// Strip the AbuseIPDB key before the policy leaves the server; report only
// whether one is stored, exactly as publicMail does for the SMTP password. An
// admin-only route is still no place for a live secret to sit in browser JS,
// devtools, a HAR export, or a future admin-page XSS.
function publicSecurityPolicy(policy: SecurityPolicy) {
  const { abuseIpdbKey, ...rest } = policy;
  return { ...rest, hasAbuseIpdbKey: Boolean(abuseIpdbKey) };
}

export async function securityRoutes(app: FastifyInstance) {
  app.get("/api/security", { preHandler: app.requireAdmin }, async () => ({
    policy: publicSecurityPolicy(getSecurityPolicy()),
    proxy: {
      trustProxyHops: getTrustProxyHops(),
      configured: getTrustProxyHops() > 0,
      forwardedHeaderSeen: wasForwardedHeaderSeen()
    },
    passwordPolicy: getPasswordPolicy(),
    mailConfigured: isMailConfigured(),
    // Who the outside-MFA policy's email fallback would apply to. Shown when the
    // admin turns it on, so nobody discovers a stranded account from a hotel room.
    usersWithoutMfa: (
      db
        .prepare(
          "SELECT display_name FROM users WHERE is_active = 1 AND deleted_at IS NULL AND mfa_enabled = 0 ORDER BY display_name"
        )
        .all() as { display_name: string }[]
    ).map((row) => row.display_name),
    trustedNetworks: listTrustedNetworks().map((network) => ({
      id: network.id,
      cidr: network.cidr,
      label: network.label,
      createdAt: network.created_at
    })),
    blockedIps: listBlockedIps().map((entry) => {
      const reputation = getCachedReputation(entry.ip_address);
      return {
        ip: entry.ip_address,
        reason: entry.reason,
        auto: Boolean(entry.auto),
        createdAt: entry.created_at,
        expiresAt: entry.expires_at,
        expired: Boolean(entry.expired),
        reputation:
          reputation && typeof reputation.score === "number"
            ? {
                score: reputation.score,
                totalReports: reputation.total_reports,
                lastReportedAt: reputation.last_reported_at,
                checkedAt: reputation.checked_at
              }
            : null
      };
    })
  }));

  app.patch("/api/security/policy", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(policySchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid thresholds", details: parsed.error });
    }
    // Turning the new-network alert on seeds the known networks from sign-in
    // history first, so devices already in use don't each raise an alert.
    const before = getSecurityPolicy();
    const enablingAlert = parsed.data.alertNewIpSignIn && !before.alertNewIpSignIn;
    if (enablingAlert) seedKnownLoginNetworks();
    // Blank/omitted key = keep what's stored — read from the RAW (still-sealed)
    // column, not the opened value, so a transiently unreadable key isn't wiped by
    // a routine save. An explicit clearAbuseIpdbKey removes it.
    const { clearAbuseIpdbKey, abuseIpdbKey: submittedKey, ...restPolicy } = parsed.data;
    const next: SecurityPolicy = {
      ...restPolicy,
      abuseIpdbKey: clearAbuseIpdbKey ? "" : submittedKey?.length ? submittedKey : getStoredAbuseIpdbKeyRaw()
    };
    setSecurityPolicy(next, request.user!.id);
    // The outside-MFA switch changes who can sign in at all, so its flips are
    // named in the log rather than folded into a generic "thresholds" line.
    const mfaFlipped = parsed.data.requireMfaOutside !== before.requireMfaOutside;
    logActivity({
      event: "security.policy_updated",
      actorUserId: request.user!.id,
      detail: mfaFlipped
        ? `A second factor is ${parsed.data.requireMfaOutside ? "now required" : "no longer required"} for sign-ins from outside trusted networks.`
        : "Updated brute-force protection thresholds.",
      ipAddress: request.ip
    });
    return reply.send({ policy: publicSecurityPolicy(next) });
  });

  app.patch("/api/security/password-policy", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(passwordPolicySchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid password policy", details: parsed.error });
    }
    setPasswordPolicy(parsed.data, request.user!.id);
    logActivity({
      event: "security.password_policy_updated",
      actorUserId: request.user!.id,
      detail: "Updated the password policy.",
      ipAddress: request.ip
    });
    return reply.send({ passwordPolicy: parsed.data });
  });

  app.post("/api/security/trusted-networks", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(trustedSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid network", details: parsed.error });
    }
    if (!isValidCidr(parsed.data.cidr)) {
      return reply.code(400).send({ error: "Enter a valid IP address or CIDR range (e.g. 192.168.1.0/24)." });
    }
    try {
      const id = addTrustedNetwork(parsed.data.cidr, parsed.data.label?.length ? parsed.data.label : null, request.user!.id);
      logActivity({
        event: "security.trusted_network_added",
        actorUserId: request.user!.id,
        detail: `Added trusted network ${parsed.data.cidr}.`,
        ipAddress: request.ip
      });
      return reply.code(201).send({ id });
    } catch {
      return reply.code(409).send({ error: "That network is already trusted." });
    }
  });

  app.delete("/api/security/trusted-networks/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!removeTrustedNetwork(id)) {
      return reply.code(404).send({ error: "Trusted network not found" });
    }
    logActivity({
      event: "security.trusted_network_removed",
      actorUserId: request.user!.id,
      detail: "Removed a trusted network.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  app.post("/api/security/blocked-ips", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(blockSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid IP address", details: parsed.error });
    }
    // A block targets a single host — reject ranges (the store keys on exact IP).
    if (parsed.data.ip.includes("/") || !isValidCidr(parsed.data.ip)) {
      return reply.code(400).send({ error: "Enter a single valid IP address." });
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
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/security/blocked-ips/:ip", { preHandler: app.requireAdmin }, async (request, reply) => {
    const ip = (request.params as { ip: string }).ip;
    if (!unblockIp(ip)) {
      return reply.code(404).send({ error: "Blocked IP not found" });
    }
    logActivity({
      event: "security.ip_unblocked",
      actorUserId: request.user!.id,
      detail: `Unblocked IP ${ip}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // On-demand reputation check from the Blocked IPs page. Forces past the cache
  // so "Check reputation" always answers with today's data.
  app.post("/api/security/blocked-ips/:ip/reputation", { preHandler: app.requireAdmin }, async (request, reply) => {
    const ip = (request.params as { ip: string }).ip;
    if (!getSecurityPolicy().abuseIpdbKey) {
      return reply.code(409).send({ error: "Add an AbuseIPDB API key under Security → Policies first." });
    }
    const reputation = await checkIpReputation(ip, { force: true });
    if (!reputation || typeof reputation.score !== "number") {
      return reply.code(502).send({ error: "The AbuseIPDB lookup failed. Try again in a moment." });
    }
    return reply.send({
      reputation: {
        score: reputation.score,
        totalReports: reputation.total_reports,
        lastReportedAt: reputation.last_reported_at,
        checkedAt: reputation.checked_at
      }
    });
  });

  // Escalate an existing (usually automatic, cooldown-limited) block into one
  // that never expires. Works on an expired row too — it re-arms the block.
  app.post("/api/security/blocked-ips/:ip/permanent", { preHandler: app.requireAdmin }, async (request, reply) => {
    const ip = (request.params as { ip: string }).ip;
    if (!makeIpBlockPermanent(ip, request.user!.id)) {
      return reply.code(404).send({ error: "Blocked IP not found" });
    }
    logActivity({
      event: "security.ip_block_made_permanent",
      actorUserId: request.user!.id,
      detail: `Made the block on IP ${ip} permanent.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });
}
