import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db, logActivity, publicUser, type User } from "../db.js";
import { verifyPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody, requestOrigin } from "./shared.js";
import { alertDeviceLinked, alertDeviceLinkRejected, alertRemoteDeviceLinked, flagAbusiveRequest } from "./security-alerts.js";
import {
  approveLinkRequest,
  attachSession,
  closeLinkWindow,
  createLinkRequest,
  denyLinkRequest,
  describeNetwork,
  describeUserAgent,
  deviceLinkAccess,
  findPendingByUserCode,
  formatUserCode,
  liveWindowFor,
  noteFailedApproval,
  pollLinkRequest,
  sweepLinkRequests,
  sweepLinkWindows,
  userCodeExists,
  POLL_INTERVAL_SECONDS
} from "./device-link.js";

// Routes for linking a device. Thin wrappers over core/device-link.ts, adding the
// policy check, rate limits, the password gate, logging and alerts — the same
// split mfa-routes.ts has over mfa.ts.
//
// A NOTE ON CSRF, because the next person here will be holding a native client and
// a deadline: /api/auth/device/* are unauthenticated POSTs and are deliberately
// INSIDE the CSRF check (core/csrf.ts). Today every caller is a browser — the
// device is a page at /link — so it picks up the token cookie on that first GET and
// nothing special is needed. A future native TV app has no such cookie, and the
// justification for exempting these two routes would be that the device code is
// itself an unguessable bearer secret that no cross-site page can obtain. That
// exemption should be narrow (start + poll only) and written down when it is made,
// not assumed now.

const startSchema = z.looseObject({});
const pollSchema = z.object({ deviceCode: z.string().min(1).max(200) });
const approveSchema = z.object({ currentPassword: z.string().min(1).max(200) });

export async function deviceLinkRoutes(app: FastifyInstance) {
  // Requests are one per attempt, including every abandoned one, and nothing else
  // in this app purges anything. A boot is the natural moment.
  try {
    const swept = sweepLinkRequests() + sweepLinkWindows();
    if (swept > 0) app.log.info(`Cleared ${swept} expired device-link row${swept === 1 ? "" : "s"}.`);
  } catch (err) {
    app.log.warn({ err }, "Could not clear expired device-link rows.");
  }

  // ── The device ─────────────────────────────────────────────────────────────

  app.post("/api/auth/device/start", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (parseBody(startSchema, request.body ?? {}).error) {
      return reply.code(400).send({ error: "Invalid request" });
    }

    // Before anything is created: is this device even allowed to ask? Refusing here
    // means a remote attacker cannot open a request to phish an approval for —
    // except during a registration window an admin has opened, when a request may
    // be created from outside and is marked `remote` so approval can insist the
    // approver is the person the window was opened for.
    const verdict = deviceLinkAccess(request.ip, request.headers as Record<string, unknown>);
    if (!verdict.allowed) {
      logActivity({
        event: "auth.device_link_rejected",
        detail: verdict.reason === "proxy"
          ? "Refused a device-link request: a proxy is in front but TRUST_PROXY_HOPS is unset, so the device's address can't be established."
          : "Refused a device-link request from outside the home network.",
        ipAddress: request.ip
      });
      alertDeviceLinkRejected(request.ip, verdict.reason);
      return reply.code(403).send({
        error: verdict.reason === "proxy"
          ? "This server can't tell which network devices are on. Ask your administrator to set TRUST_PROXY_HOPS."
          : "Devices can only be linked from your home network. Ask your administrator if you need this from elsewhere.",
        reason: verdict.reason
      });
    }

    const created = createLinkRequest({
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
      ip: request.ip,
      remote: verdict.remote
    });

    logActivity({
      event: "auth.device_link_requested",
      detail: `A device asked to be linked (${describeUserAgent(request.headers["user-agent"] as string)})${verdict.remote ? ", from outside the home network" : ""}.`,
      ipAddress: request.ip
    });

    // Built from the origin the device is actually using, never config.appUrl: that
    // address is the one provably reaching this server from where the QR will be
    // scanned. The "complete" form is what the QR encodes — it carries the code so
    // the phone lands on the confirmation screen, which still shows the code to be
    // compared against the screen across the room.
    const origin = requestOrigin(request);
    return reply.code(201).send({
      deviceCode: created.deviceCode,
      userCode: created.userCode,
      userCodeDisplay: created.userCodeDisplay,
      verificationUrl: `${origin}/link`,
      verificationUrlComplete: `${origin}/link/${created.userCode}`,
      expiresAt: created.expiresAt,
      interval: POLL_INTERVAL_SECONDS
    });
  });

  // "Am I in yet?" An approved outcome is claimed by this call (see
  // pollLinkRequest), so the session has to be issued here or the request is burnt.
  app.post("/api/auth/device/poll", {
    config: { rateLimit: { max: 40, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsed = parseBody(pollSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid request" });
    }

    const outcome = pollLinkRequest(parsed.data.deviceCode);

    // A device code matching no row at all can only be a guess or a scan. One that
    // matches a real request which merely expired is a display left on overnight,
    // and counting that would block the household for using the feature.
    if (outcome.status === "unknown") {
      flagAbusiveRequest(request, "token");
      return reply.code(404).send({ status: "unknown" });
    }

    if (outcome.status !== "approved") {
      return reply.send({ status: outcome.status, interval: POLL_INTERVAL_SECONDS });
    }

    const user = db.prepare(
      "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(outcome.row.approved_by) as User | undefined;
    // Approved by an account that has since been deactivated or removed. The
    // request is already spent; the device starts over, which is correct — there is
    // no longer an account for it to be.
    if (!user) {
      return reply.send({ status: "expired", interval: POLL_INTERVAL_SECONDS });
    }

    const label = describeUserAgent(outcome.row.user_agent);
    const sessionId = issueSession(reply, user.id, request, {
      kind: "device",
      label,
      days: config.deviceSessionDays
    });
    attachSession(outcome.row.id, sessionId);

    // One window, one device. Spent here rather than at approval, so an approval
    // nobody collects doesn't burn the hour — the same reasoning that makes the
    // request itself single-use only once a session actually exists.
    if (outcome.row.remote === 1) {
      const window = liveWindowFor(user.id);
      if (window) closeLinkWindow(window.id, sessionId);
      alertRemoteDeviceLinked(user, request, label);
    }

    logActivity({
      event: outcome.row.remote === 1 ? "auth.device_link_remote" : "auth.device_link_redeemed",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: outcome.row.remote === 1
        ? `A device ("${label}") was linked from outside the home network.`
        : `A linked device ("${label}") signed in.`,
      ipAddress: request.ip
    });

    return reply.send({ status: "approved", user: publicUser(user) });
  });

  // ── The phone ──────────────────────────────────────────────────────────────

  // What the confirmation screen shows. Nothing here is a secret — the caller is
  // signed in and already holds the code — but everything here is attacker-supplied
  // text, so it is described rather than echoed.
  app.get("/api/auth/device/:userCode", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { userCode } = request.params as { userCode: string };
    const row = findPendingByUserCode(userCode);
    if (!row) {
      // Unknown, expired, and already-answered are one answer to the caller: a
      // distinct "wrong code" would confirm which codes exist. Only a code that has
      // never existed counts against the caller's IP.
      if (!userCodeExists(userCode)) flagAbusiveRequest(request, "token");
      return reply.code(404).send({ error: "That code has expired or doesn't exist. Check the screen and try again." });
    }

    return reply.send({
      userCode: row.user_code,
      userCodeDisplay: formatUserCode(row.user_code),
      device: describeUserAgent(row.user_agent),
      network: describeNetwork(row.ip_address),
      ipAddress: row.ip_address,
      requestedAt: row.created_at,
      expiresAt: row.expires_at
    });
  });

  app.post("/api/auth/device/:userCode/approve", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { userCode } = request.params as { userCode: string };
    const parsed = parseBody(approveSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter your password to authorize this device", details: parsed.error });
    }

    // A linked display cannot authorize further displays, password or not. It is a
    // session sitting in a room anyone can walk into, and "approve a new device"
    // is the one power that would let whoever is standing there turn a screen into
    // a permanent second key. Checked before the code is even resolved.
    if (request.sessionKind === "device") {
      return reply.code(403).send({
        error: "A linked device can't authorize other devices. Use a phone or computer you signed in on."
      });
    }

    const row = findPendingByUserCode(userCode);
    if (!row) {
      if (!userCodeExists(userCode)) flagAbusiveRequest(request, "token");
      return reply.code(404).send({ error: "That code has expired or doesn't exist. Check the screen and try again." });
    }

    const user = request.user!;
    // The same gate that governs enrolling a second factor or a passkey. Approving
    // mints a session that lasts a year, so an unlocked phone alone must not be
    // enough — it costs what turning off two-factor costs.
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      const remaining = noteFailedApproval(row.id);
      logActivity({
        event: "auth.device_link_approve_failed",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        detail: `Wrong password while authorizing a device; ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
        ipAddress: request.ip
      });
      return reply.code(401).send({
        error: remaining > 0
          ? "That password isn't right."
          : "That password isn't right, and this request has been cancelled. Start again on the device.",
        remaining
      });
    }

    // A request that came from outside may only be approved by the person an admin
    // opened a window for. This is where "for user X" is actually enforced: the
    // request itself was created by an anonymous device that could say nothing
    // about whose it was. After the password check, so a wrong password never
    // reveals whether a window exists.
    if (row.remote === 1 && !liveWindowFor(user.id)) {
      logActivity({
        event: "auth.device_link_remote_refused",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        detail: "Tried to authorize a device from outside the home network without an open registration window.",
        ipAddress: request.ip
      });
      return reply.code(403).send({
        error: "Linking a device from outside your home network has to be turned on for your account by an administrator."
      });
    }

    if (!approveLinkRequest(row.id, user.id)) {
      // It expired or was answered between the screen loading and the button.
      return reply.code(409).send({ error: "That request is no longer waiting. Start again on the device." });
    }

    const label = describeUserAgent(row.user_agent);
    logActivity({
      event: "auth.device_link_approved",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: `Authorized a device ("${label}") on ${describeNetwork(row.ip_address)}.`,
      ipAddress: request.ip
    });
    alertDeviceLinked(user, request, label);

    return reply.send({ ok: true, device: label });
  });

  // No password gate on the way out. Denying is the safe direction, and a gate here
  // only teaches people to close the tab instead — which leaves the request live.
  app.post("/api/auth/device/:userCode/deny", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { userCode } = request.params as { userCode: string };
    const row = findPendingByUserCode(userCode);
    if (!row) {
      if (!userCodeExists(userCode)) flagAbusiveRequest(request, "token");
      return reply.code(404).send({ error: "That code has expired or doesn't exist." });
    }

    denyLinkRequest(row.id);
    logActivity({
      event: "auth.device_link_denied",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: `Refused a device ("${describeUserAgent(row.user_agent)}") on ${describeNetwork(row.ip_address)}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });
}
