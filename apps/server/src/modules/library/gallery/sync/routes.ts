// Phone sync, phase 2 (docs/photo-sync-plan.md): the admin's phone-sync networks card
// (Security › Networks, beside Trusted networks) and the member's Profile › My library ›
// Phones. The /dav endpoint itself is dav.ts (phase 3), built on authenticatePhone().
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logActivity } from "../../../../db.js";
import { parseBody } from "../../../../core/shared.js";
import { personalLibraryIdOf } from "../personal/personal-libraries.js";
import {
  addSyncNetwork, copyTrustedNetworks, getSavedSyncAddress, isPhoneSyncOn, listSyncNetworks, parseSyncAddress,
  phoneSyncAddress, removeSyncNetwork, saveSyncAddress, syncAddressOutsideNetworks, SyncNetworkError
} from "./networks.js";
import { addPhone, listPhones, MAX_PHONES, PhoneError, revokePhone, type Phone } from "./devices.js";
import { phoneStatuses, type PhoneStatus } from "./status.js";
import { librarySize } from "../personal/service.js";

/** Where phones send to (dav.ts serves it). */
export const DAV_PATH = "/dav/";

const networkSchema = z.object({
  cidr: z.string().trim().min(1).max(64),
  label: z.string().trim().max(60).optional()
});
const addressSchema = z.object({ address: z.string().trim().max(300).nullable() });
const phoneSchema = z.object({ label: z.string().trim().min(1).max(60) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof SyncNetworkError || err instanceof PhoneError) {
    return reply.code(err.statusCode).send({ error: err.message, code: err.code });
  }
  throw err;
}

function adminView() {
  return {
    networks: listSyncNetworks().map((n) => ({ id: n.id, cidr: n.cidr, label: n.label, createdAt: n.created_at })),
    address: getSavedSyncAddress(),
    // A warning, never a block: the address is an IP outside every listed network.
    addressOutsideNetworks: syncAddressOutsideNetworks()
  };
}

function serializePhone(phone: Phone, status: PhoneStatus | undefined) {
  return { id: phone.id, label: phone.label, createdAt: phone.created_at, lastSeen: phone.last_seen_at, lastIp: phone.last_ip, status: status ?? null };
}

/** The member's own phones, with how each one's backup is going. */
function ownPhones(userId: string) {
  const phones = listPhones(userId);
  const statuses = phoneStatuses(phones);
  return phones.map((phone) => serializePhone(phone, statuses.get(phone.id)));
}

/** A member's page, for an admin: their personal library's size and their phones —
 *  name, added, last contact, and a problem only when it is about the phone or the
 *  server (not reached, disk full). Never counts of what was sent, never a file. */
function memberView(userId: string) {
  const libraryId = personalLibraryIdOf(userId);
  const phones = listPhones(userId);
  const statuses = phoneStatuses(phones, true);
  return {
    library: libraryId ? { id: libraryId, sizeBytes: librarySize(libraryId).bytes } : null,
    phones: phones.map((phone) => ({
      id: phone.id,
      label: phone.label,
      createdAt: phone.created_at,
      lastSeen: phone.last_seen_at,
      problem: statuses.get(phone.id)?.problem ?? null
    }))
  };
}

type PhonesUnavailable = "off" | "no_library";

function phonesView(request: FastifyRequest) {
  const user = request.user!;
  const hasLibrary = personalLibraryIdOf(user.id) != null;
  const unavailable: PhonesUnavailable | null = !isPhoneSyncOn() ? "off" : !hasLibrary ? "no_library" : null;
  return {
    unavailable,
    maxPhones: MAX_PHONES,
    phones: ownPhones(user.id)
  };
}

function setupDetails(request: FastifyRequest) {
  const address = phoneSyncAddress();
  return {
    // null: the admin hasn't set "Address phones use" yet — the card says so.
    address: address?.url ?? null,
    host: address?.host ?? null,
    port: address?.port ?? null,
    path: DAV_PATH,
    ssl: address?.ssl ?? false,
    username: request.user!.email
  };
}

export async function photoSyncRoutesPlugin(app: FastifyInstance) {
  // ── The admin: phone-sync networks ──
  app.get("/api/photo-sync/networks", { preHandler: app.requireAdmin }, async () => adminView());

  app.post("/api/photo-sync/networks", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(networkSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid network", details: parsed.error });
    try {
      addSyncNetwork(parsed.data.cidr, parsed.data.label?.length ? parsed.data.label : null, request.user!.id);
    } catch (err) {
      return sendError(reply, err);
    }
    logActivity({
      event: "photo_sync.network_added",
      actorUserId: request.user!.id,
      detail: `Added phone-sync network ${parsed.data.cidr}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send(adminView());
  });

  app.post("/api/photo-sync/networks/copy-trusted", { preHandler: app.requireAdmin }, async (request, reply) => {
    const added = copyTrustedNetworks(request.user!.id);
    if (added > 0) {
      logActivity({
        event: "photo_sync.network_added",
        actorUserId: request.user!.id,
        detail: `Copied ${added} trusted network(s) to the phone-sync networks.`,
        ipAddress: request.ip
      });
    }
    return reply.send({ ...adminView(), added });
  });

  // untrustedAllow: taking a network off the list only ever closes the door.
  app.delete("/api/photo-sync/networks/:id", { preHandler: app.requireAdmin, config: { untrustedAllow: true } }, async (request, reply) => {
    const removed = removeSyncNetwork((request.params as { id: string }).id);
    if (!removed) return reply.code(404).send({ error: "Network not found" });
    logActivity({
      event: "photo_sync.network_removed",
      actorUserId: request.user!.id,
      detail: `Removed phone-sync network ${removed.cidr}.`,
      ipAddress: request.ip
    });
    return reply.send(adminView());
  });

  app.put("/api/photo-sync/address", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(addressSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Invalid address", details: parsed.error });
    const raw = parsed.data.address;
    const address = raw ? parseSyncAddress(raw) : null;
    if (raw && !address) {
      return reply.code(400).send({ error: "Enter an http:// or https:// address with the port, such as http://192.168.2.10:4000.", code: "bad_address" });
    }
    saveSyncAddress(address, request.user!.id);
    logActivity({
      event: "photo_sync.address_set",
      actorUserId: request.user!.id,
      detail: address
        ? `Phones are told to connect to ${address}.`
        : "Cleared the address phones are told to connect to.",
      ipAddress: request.ip
    });
    return reply.send(adminView());
  });

  // ── The admin: a member's page ──
  app.get("/api/photo-sync/members/:userId", { preHandler: app.requireAdmin }, async (request) =>
    memberView((request.params as { userId: string }).userId));

  // untrustedAllow: revoking a phone only ever closes the door.
  app.delete("/api/photo-sync/members/:userId/phones/:id", { preHandler: app.requireAdmin, config: { untrustedAllow: true } }, async (request, reply) => {
    const { userId, id } = request.params as { userId: string; id: string };
    if (!revokePhone(userId, id, request.ip, request.user!.id)) return reply.code(404).send({ error: "Phone not found" });
    return reply.send(memberView(userId));
  });

  // ── The member: Profile › My library › Phones ──
  app.get("/api/profile/phones", { preHandler: app.authenticate }, async (request) => phonesView(request));

  app.post("/api/profile/phones", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(phoneSchema, request.body);
    if (parsed.error) return reply.code(400).send({ error: "Give the phone a name.", code: "no_label", details: parsed.error });
    if (!isPhoneSyncOn()) {
      return reply.code(409).send({ error: "Phone sync is unavailable: no phone-sync network is set.", code: "sync_off" });
    }
    let added: ReturnType<typeof addPhone>;
    try {
      added = addPhone(request.user!, parsed.data.label, request.ip);
    } catch (err) {
      return sendError(reply, err);
    }
    // The token is in this answer and nowhere else, ever.
    return reply.code(201).send({
      ...phonesView(request),
      added: { id: added.id, label: parsed.data.label, token: added.raw, setup: setupDetails(request) }
    });
  });

  // untrustedAllow: revoking a phone protects the account — never refused.
  app.delete("/api/profile/phones/:id", { preHandler: app.authenticate, config: { untrustedAllow: true } }, async (request, reply) => {
    if (!revokePhone(request.user!.id, (request.params as { id: string }).id, request.ip)) {
      return reply.code(404).send({ error: "Phone not found" });
    }
    return reply.send(phonesView(request));
  });
}
