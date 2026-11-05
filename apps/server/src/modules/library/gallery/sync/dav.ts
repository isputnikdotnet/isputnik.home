// The phone-sync endpoint: a small WebDAV subset at /dav (docs/photo-sync-plan.md,
// decisions 6–9, phase 3). Written for what PhotoSync for Android was seen to send
// (plan › Spike results): per file `MKCOL` ×2 → `PROPFIND` Depth 1 of the album
// folder → `PUT` to the final name with `X-OC-Mtime` → `PROPPATCH getlastmodified`.
//
// Every request but OPTIONS passes both checks in authenticatePhone(): it comes from
// a phone-sync network AND carries a live `photo-sync` token whose member and personal
// library are still theirs — re-checked each time, so a revoke, a removed member or a
// network taken off the list stops the phone at once. Refused by network: 403, no
// challenge (a password won't help). Refused by credentials: 401 with a challenge.
//
// A phone only ever sees its own namespace (namespace.ts); nothing here lists or
// serves the library. Upload only: DELETE is 403, nothing is overwritten.
//
// No cookies and no session are read here, so /dav sits outside CSRF and the probe
// detector (core/csrf.ts, core/probes.ts). It has its own rate limit, per token.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sha256 } from "../../../../crypto.js";
import { authenticatePhone, basicPassword, type PhoneIdentity } from "./devices.js";
import {
  DAV_PREFIX, davPathOf, destinationPathOf, fileAt, folderCreatedAt, folderExists, hrefFor, listChildren, makeFolder,
  moveInNamespace, parentOf, setClientMtime, type ListedEntry, type SyncFile
} from "./namespace.js";
import { parseClientDate, PutRefused, receivePut, redateFromClient, sweepStaleSyncStaging } from "./put.js";
import { recordPhoneProblem } from "./status.js";

const DAV_METHODS = ["PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"] as const;
const ALL_METHODS = ["OPTIONS", "GET", "HEAD", "PUT", "DELETE", ...DAV_METHODS];
/** XML bodies (PROPFIND, PROPPATCH, LOCK) are read up to this; anything longer is refused. */
const MAX_XML_BODY = 64 * 1024;
/** Requests one phone may make a minute. A first backup is five requests a file
 *  (MKCOL ×2, PROPFIND, PUT, PROPPATCH); this is ~4 files a second, far above what the
 *  spike saw (a manual run of 44 files, Autotransfer's two minutes for 46 checks). */
export const PHONE_RATE_PER_MINUTE = 1200;
const REALM = 'Basic realm="iSputnik photo sync", charset="UTF-8"';

const xmlEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const multistatus = (responses: string[]): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", gif: "image/gif",
  webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", "3gp": "video/3gpp", webm: "video/webm"
};

const httpDate = (iso: string | null | undefined): string => new Date(iso ?? Date.now()).toUTCString();
const etagOf = (file: SyncFile): string => `"${file.sha256}"`;

function propResponse(entry: ListedEntry): string {
  const name = entry.path === "/" ? "" : entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const props = [
    `<d:displayname>${xmlEscape(name)}</d:displayname>`,
    `<d:resourcetype>${entry.folder ? "<d:collection/>" : ""}</d:resourcetype>`
  ];
  if (entry.file) {
    const file = entry.file;
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    props.push(
      `<d:getlastmodified>${httpDate(file.client_mtime ?? file.received_at)}</d:getlastmodified>`,
      `<d:creationdate>${new Date(file.received_at).toISOString()}</d:creationdate>`,
      `<d:getcontentlength>${file.size}</d:getcontentlength>`,
      `<d:getetag>${xmlEscape(etagOf(file))}</d:getetag>`,
      `<d:getcontenttype>${CONTENT_TYPES[ext] ?? "application/octet-stream"}</d:getcontenttype>`
    );
  } else {
    props.push(`<d:getlastmodified>${httpDate(entry.createdAt)}</d:getlastmodified>`);
  }
  return `<d:response><d:href>${xmlEscape(hrefFor(entry.path, entry.folder))}</d:href>` +
    `<d:propstat><d:prop>${props.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

/** Reads a small XML body. Null when it is too long (the rest is drained). */
async function readXmlBody(request: FastifyRequest): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.raw) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total <= MAX_XML_BODY) chunks.push(buffer);
  }
  return total > MAX_XML_BODY ? null : Buffer.concat(chunks).toString("utf8");
}

/** Lets an unread body go so the client hears the answer rather than a reset. */
function drain(request: FastifyRequest): void {
  if (!request.raw.readableEnded) request.raw.resume();
}

/** Per token when one is sent (hashed — never the raw secret as a key), else per address. */
function rateKey(request: FastifyRequest): string {
  const password = basicPassword(request.headers.authorization);
  return password ? `dav-token:${sha256(password).slice(0, 32)}` : `dav-ip:${request.ip}`;
}

function entryAt(phone: PhoneIdentity, davPath: string): ListedEntry | null {
  const file = fileAt(phone.deviceId, davPath);
  if (file) return { path: davPath, folder: false, file };
  if (folderExists(phone.deviceId, davPath)) return { path: davPath, folder: true, createdAt: folderCreatedAt(phone.deviceId, davPath) };
  return null;
}

async function handle(request: FastifyRequest, reply: FastifyReply, phone: PhoneIdentity, davPath: string) {
  switch (request.method) {
    case "PROPFIND": {
      if ((await readXmlBody(request)) === null) return reply.code(413).send();
      const entry = entryAt(phone, davPath);
      if (!entry) return reply.code(404).send();
      const responses = [propResponse(entry)];
      // Depth infinity is answered as 1: the namespace is the phone's own and small.
      if (entry.folder && String(request.headers.depth ?? "infinity") !== "0") {
        for (const child of listChildren(phone.deviceId, davPath)) responses.push(propResponse(child));
      }
      return reply.code(207).type("application/xml; charset=utf-8").send(multistatus(responses));
    }

    case "MKCOL": {
      if ((await readXmlBody(request)) === null) return reply.code(415).send();
      if (davPath === "/" || fileAt(phone.deviceId, davPath)) return reply.code(405).send();
      if (!folderExists(phone.deviceId, parentOf(davPath))) return reply.code(409).send();
      return reply.code(makeFolder(phone.deviceId, davPath) ? 201 : 405).send();
    }

    case "PUT": {
      if (davPath === "/" || folderExists(phone.deviceId, davPath)) {
        drain(request);
        return reply.code(405).send();
      }
      try {
        const outcome = await receivePut(request, phone, davPath);
        reply.header("ETag", `"${outcome.sha256}"`);
        reply.header("OC-ETag", `"${outcome.sha256}"`);
        if (request.headers["x-oc-mtime"] !== undefined) reply.header("X-OC-MTime", "accepted");
        return reply.code(outcome.status).send();
      } catch (err) {
        const problemOf = { deviceId: phone.deviceId, userId: phone.user.id, label: phone.label };
        if (!(err instanceof PutRefused)) {
          recordPhoneProblem(problemOf, "server_error", null, request.ip ?? null);
          throw err;
        }
        recordPhoneProblem(problemOf, err.problem, err.detail, request.ip ?? null);
        drain(request);
        // A refused body may still be on its way; don't keep the connection for it.
        reply.header("Connection", "close");
        request.log.info({ status: err.statusCode, path: davPath, device: phone.deviceId }, `Photo sync refused a file: ${err.message}`);
        return reply.code(err.statusCode).type("text/plain; charset=utf-8").send(err.message);
      }
    }

    case "PROPPATCH": {
      const body = await readXmlBody(request);
      if (body === null) return reply.code(413).send();
      const entry = entryAt(phone, davPath);
      if (!entry) return reply.code(404).send();
      // getlastmodified (or Win32LastModifiedTime) — PhotoSync sends bare unix seconds.
      const match = /<[^>]*(?:getlastmodified|Win32LastModifiedTime)[^>]*>([^<]+)</i.exec(body);
      const date = parseClientDate(match?.[1]);
      if (date && entry.file) {
        const before = entry.file.client_mtime;
        setClientMtime(entry.file.id, date.toISOString());
        if (!before && entry.file.item_id) await redateFromClient(phone, entry.file.item_id, date);
      }
      return reply.code(207).type("application/xml; charset=utf-8").send(multistatus([
        `<d:response><d:href>${xmlEscape(hrefFor(davPath, entry.folder))}</d:href>` +
        `<d:propstat><d:prop><d:getlastmodified/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      ]));
    }

    case "HEAD": {
      const entry = entryAt(phone, davPath);
      if (!entry) return reply.code(404).send();
      if (entry.file) {
        reply.header("ETag", etagOf(entry.file));
        reply.header("Content-Length", entry.file.size);
        reply.header("Last-Modified", httpDate(entry.file.client_mtime ?? entry.file.received_at));
      }
      return reply.code(200).send();
    }

    case "GET": {
      // Upload only in V1: nothing comes back out through /dav.
      const entry = entryAt(phone, davPath);
      return reply.code(entry ? 403 : 404).send();
    }

    case "MOVE": {
      if ((await readXmlBody(request)) === null) return reply.code(413).send();
      const destination = destinationPathOf(request.headers.destination);
      if (!destination) return reply.code(400).send("Bad Destination");
      const overwrite = String(request.headers.overwrite ?? "T").toUpperCase() !== "F";
      const existed = Boolean(entryAt(phone, destination));
      const result = moveInNamespace(phone.deviceId, davPath, destination, overwrite);
      if (result === "missing") return reply.code(404).send();
      if (result === "exists") return reply.code(412).send();
      if (result === "conflict") return reply.code(409).send();
      return reply.code(existed ? 204 : 201).send();
    }

    case "COPY":
      drain(request);
      return reply.code(501).send();

    case "DELETE":
      // Upload only: a photo deleted on the phone stays at home (decision 10).
      drain(request);
      return reply.code(403).send("Deleting is not allowed.");

    case "LOCK": {
      if ((await readXmlBody(request)) === null) return reply.code(413).send();
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      reply.header("Lock-Token", `<${token}>`);
      return reply.code(200).type("application/xml; charset=utf-8").send(
        `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>` +
        `<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth>` +
        `<d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken>` +
        `</d:activelock></d:lockdiscovery></d:prop>`
      );
    }

    case "UNLOCK":
      drain(request);
      return reply.code(204).send();

    default:
      drain(request);
      return reply.code(405).send();
  }
}

export async function photoSyncDavPlugin(app: FastifyInstance) {
  for (const method of DAV_METHODS) {
    // The methods are the root's; a second boot (tests) must not add them again.
    if (!app.hasDecorator(method.toLowerCase())) app.addHttpMethod(method, { hasBody: true });
  }
  // Bodies stay unread until a handler streams them: an upload is never buffered.
  // Scoped to this plugin (encapsulated), so the rest of the app keeps its parsers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => done(null));

  try {
    const removed = sweepStaleSyncStaging();
    if (removed > 0) app.log.info(`Photo sync: removed ${removed} unfinished upload folder(s) left from before.`);
  } catch (err) {
    app.log.warn({ err }, "Photo sync: could not sweep unfinished upload folders");
  }

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("DAV", "1, 2");
    reply.header("MS-Author-Via", "DAV");
    const davPath = davPathOf(request.url);
    if (davPath === null) {
      drain(request);
      return reply.code(400).send("Bad path");
    }
    if (request.method === "OPTIONS") {
      reply.header("Allow", ALL_METHODS.join(", "));
      return reply.code(200).send();
    }

    const auth = authenticatePhone(request);
    if (!auth.ok) {
      drain(request);
      if (auth.reason === "network") return reply.code(403).send("Phone sync is not available from this network.");
      reply.header("WWW-Authenticate", REALM);
      return reply.code(401).send("Authentication required");
    }
    return handle(request, reply, auth.phone, davPath);
  };

  // Per token, not per address, and never waived for a trusted network: the cap is
  // about what one phone may do, wherever it is.
  const routeOptions = {
    config: {
      rateLimit: { max: PHONE_RATE_PER_MINUTE, timeWindow: "1 minute", keyGenerator: rateKey, allowList: null as never, groupId: "photo-sync" }
    },
    // HEAD is answered by the handler itself, not Fastify's automatic GET twin.
    exposeHeadRoute: false
  };
  for (const url of [DAV_PREFIX, `${DAV_PREFIX}/`, `${DAV_PREFIX}/*`]) {
    app.route({ method: ALL_METHODS, url, ...routeOptions, handler });
  }
}
