// Photo Sync, phase 0 — the WebDAV SPIKE (docs/photo-sync-plan.md, Roadmap).
//
// THROWAWAY. A plain WebDAV server over a scratch folder whose only job is to
// record exactly what real phone apps (PhotoSync on iOS and Android, FolderSync)
// send: which verbs, which headers, whether they PROPFIND before uploading,
// whether they PUT to a temporary name and MOVE it, how "Upload in chunks" is
// spelled on the wire, how dates and Live Photos arrive. It answers like a real
// server (files really land in the scratch folder) so the apps behave as they
// would against the finished feature.
//
// Off unless PHOTO_SYNC_SPIKE=1. It touches no library, no database row and no
// account: one shared password (PHOTO_SYNC_SPIKE_PASSWORD, default "spike"), any
// user name. Every request is appended to <dir>/requests.jsonl, and
// `node scripts/photo-sync-spike-report.mjs` turns that log into the answers.
// Delete this file, its registration in index.ts and the /dav exemptions in
// core/csrf.ts and core/probes.ts when phase 1 replaces it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { nanoid } from "nanoid";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const SPIKE_PREFIX = "/dav";

export interface PhotoSyncSpikeOptions {
  /** Scratch folder: files/ holds the uploads, requests.jsonl the log. */
  dir: string;
  /** The one password every user name signs in with. */
  password?: string;
  /** DELETE really deletes when true; otherwise 403, as phase 1 will answer. */
  allowDelete?: boolean;
}

const DAV_METHODS = ["PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"] as const;
const ALL_METHODS = ["OPTIONS", "GET", "HEAD", "PUT", "DELETE", ...DAV_METHODS];
/** Non-upload bodies (PROPFIND/PROPPATCH/LOCK XML) are kept in the log up to this. */
const MAX_LOGGED_BODY = 64 * 1024;

/** What the handler learned about a request, written out when the response is sent. */
interface SpikeNote {
  path?: string;
  user?: string | null;
  body?: string;
  bodyBytes?: number;
  sha256?: string;
  aborted?: boolean;
  error?: string;
  depth?: string;
  destination?: string;
  entries?: number;
  durationMs?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    spikeNote?: SpikeNote;
  }
}

const note = (request: FastifyRequest): SpikeNote => (request.spikeNote ??= {});

/** Headers as logged: the password never, the user name yes (it says which phone). */
function loggedHeaders(headers: FastifyRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    out[name] = name === "authorization" ? redactAuth(text) : text;
  }
  return out;
}

function redactAuth(value: string): string {
  const basic = basicCredentials(value);
  if (basic) return `Basic ${basic.user}:***`;
  return `${value.split(" ")[0] ?? "?"} ***`;
}

function basicCredentials(header: string | undefined): { user: string; password: string } | null {
  if (!header || !header.toLowerCase().startsWith("basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The request path inside the DAV tree ("/", "/2026/IMG_1.HEIC"), or null when it escapes. */
function davPath(url: string): string | null {
  const pathname = url.split("?")[0] ?? "";
  if (!pathname.startsWith(SPIKE_PREFIX)) return null;
  const rest = pathname.slice(SPIKE_PREFIX.length);
  if (rest !== "" && !rest.startsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return null; }
    if (segment === "." || segment === ".." || segment.includes("\0") || /[\\/]/.test(segment)) return null;
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** A Destination header (absolute URL or path) as a DAV path. */
function destinationPath(header: string | undefined): string | null {
  if (!header) return null;
  let pathname = header;
  try { pathname = new URL(header, "http://spike.invalid").pathname; } catch { return null; }
  return davPath(pathname);
}

const hrefFor = (davRelative: string, isDir: boolean): string => {
  const encoded = davRelative.split("/").map((s) => encodeURIComponent(s)).join("/");
  const href = `${SPIKE_PREFIX}${encoded}`;
  return isDir && !href.endsWith("/") ? `${href}/` : href;
};

const xmlEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const etagOf = (stat: fs.Stats): string => `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

function propResponse(davRelative: string, stat: fs.Stats): string {
  const isDir = stat.isDirectory();
  const name = davRelative === "/" ? "" : path.posix.basename(davRelative);
  const props = [
    `<d:displayname>${xmlEscape(name)}</d:displayname>`,
    `<d:resourcetype>${isDir ? "<d:collection/>" : ""}</d:resourcetype>`,
    `<d:getlastmodified>${stat.mtime.toUTCString()}</d:getlastmodified>`,
    `<d:creationdate>${stat.birthtime.toISOString()}</d:creationdate>`
  ];
  if (!isDir) {
    props.push(
      `<d:getcontentlength>${stat.size}</d:getcontentlength>`,
      `<d:getetag>${etagOf(stat)}</d:getetag>`,
      `<d:getcontenttype>application/octet-stream</d:getcontenttype>`
    );
  }
  return `<d:response><d:href>${xmlEscape(hrefFor(davRelative, isDir))}</d:href>` +
    `<d:propstat><d:prop>${props.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const multistatus = (responses: string[]): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;

/** Reads a small request body (XML) into the note, bounded. */
async function readSmallBody(request: FastifyRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.raw) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total <= MAX_LOGGED_BODY) chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const n = note(request);
  n.bodyBytes = total;
  if (body) n.body = total > MAX_LOGGED_BODY ? `${body}…[${total} bytes]` : body;
  return body;
}

/** "Wed, 05 Nov 2026 …", unix seconds (X-OC-Mtime) or ISO — whatever a client sends. */
function parseClientDate(value: string | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const date = /^\d+(\.\d+)?$/.test(trimmed) ? new Date(Number(trimmed) * 1000) : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function photoSyncSpikePlugin(app: FastifyInstance, options: PhotoSyncSpikeOptions): Promise<void> {
  const root = path.resolve(options.dir, "files");
  const logFile = path.resolve(options.dir, "requests.jsonl");
  const password = options.password ?? "spike";
  fs.mkdirSync(root, { recursive: true });

  for (const method of DAV_METHODS) {
    // Shared with the root instance; guarded so a second boot (tests) adds nothing.
    if (!app.hasDecorator(method.toLowerCase())) app.addHttpMethod(method, { hasBody: true });
  }
  // Bodies stay unread until a handler streams them: an upload is never buffered.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => done(null));

  const absolute = (davRelative: string): string => path.join(root, ...davRelative.split("/").filter(Boolean));

  // Logged on response, so a request a root hook refused (rate limit, deletion
  // protection) is in the log too.
  app.addHook("onResponse", async (request, reply) => {
    const n = request.spikeNote ?? {};
    const entry = {
      at: new Date().toISOString(),
      ip: request.ip,
      method: request.method,
      url: request.url,
      ...n,
      headers: loggedHeaders(request.headers),
      status: reply.statusCode,
      responseHeaders: Object.fromEntries(
        Object.entries(reply.getHeaders()).filter(([k]) => !["set-cookie", "x-robots-tag"].includes(k))
      ),
      ms: Math.round(reply.elapsedTime)
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const n = note(request);
    reply.header("DAV", "1, 2");
    reply.header("MS-Author-Via", "DAV");
    const target = davPath(request.url);
    n.path = target ?? undefined;
    if (request.headers.depth !== undefined) n.depth = String(request.headers.depth);
    if (target === null) return reply.code(400).send("Bad path");

    if (request.method === "OPTIONS") {
      reply.header("Allow", ALL_METHODS.join(", "));
      return reply.code(200).send();
    }

    const credentials = basicCredentials(request.headers.authorization);
    n.user = credentials?.user ?? null;
    if (!credentials || credentials.password !== password) {
      // Drain whatever was sent so the client sees the 401, not a reset.
      request.raw.resume();
      reply.header("WWW-Authenticate", 'Basic realm="isputnik photo sync spike", charset="UTF-8"');
      return reply.code(401).send("Authentication required");
    }

    const file = absolute(target);
    const statOf = (p: string): fs.Stats | null => { try { return fs.statSync(p); } catch { return null; } };

    switch (request.method) {
      case "PROPFIND": {
        await readSmallBody(request);
        const depth = String(request.headers.depth ?? "infinity");
        n.depth = depth;
        const stat = statOf(file);
        if (!stat) return reply.code(404).send();
        const responses = [propResponse(target, stat)];
        if (stat.isDirectory() && depth !== "0") {
          for (const name of fs.readdirSync(file)) {
            if (name.endsWith(".spike-part")) continue;
            const childStat = statOf(path.join(file, name));
            if (childStat) responses.push(propResponse(path.posix.join(target, name), childStat));
          }
        }
        n.entries = responses.length;
        return reply.code(207).type("application/xml; charset=utf-8").send(multistatus(responses));
      }

      case "PROPPATCH": {
        const body = await readSmallBody(request);
        const stat = statOf(file);
        if (!stat) return reply.code(404).send();
        // Honour a modified date if one is sent (getlastmodified / Win32LastModifiedTime).
        const match = /<[^>]*(?:getlastmodified|Win32LastModifiedTime)[^>]*>([^<]+)</i.exec(body);
        const date = parseClientDate(match?.[1]);
        if (date) fs.utimesSync(file, date, date);
        const href = hrefFor(target, stat.isDirectory());
        return reply.code(207).type("application/xml; charset=utf-8").send(multistatus([
          `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
        ]));
      }

      case "MKCOL": {
        await readSmallBody(request);
        if (statOf(file)) return reply.code(405).send();
        if (!statOf(path.dirname(file))?.isDirectory()) return reply.code(409).send();
        fs.mkdirSync(file);
        return reply.code(201).send();
      }

      case "PUT": {
        if (target === "/") return reply.code(405).send();
        if (!statOf(path.dirname(file))?.isDirectory()) {
          request.raw.resume();
          return reply.code(409).send("Parent collection missing");
        }
        const existed = Boolean(statOf(file));
        const part = `${file}.${nanoid(8)}.spike-part`;
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          }
        });
        try {
          await pipeline(request.raw, counter, fs.createWriteStream(part));
        } catch (error) {
          n.aborted = true;
          n.bodyBytes = bytes;
          n.error = (error as Error).message;
          fs.rmSync(part, { force: true });
          return reply.code(400).send();
        }
        n.bodyBytes = bytes;
        n.sha256 = hash.digest("hex");
        const declared = Number(request.headers["content-length"]);
        if (Number.isFinite(declared) && declared !== bytes) {
          n.error = `length mismatch: declared ${declared}, got ${bytes}`;
          fs.rmSync(part, { force: true });
          return reply.code(400).send();
        }
        fs.renameSync(part, file);
        const mtime = parseClientDate(
          (request.headers["x-oc-mtime"] as string | undefined) ?? (request.headers["x-file-mtime"] as string | undefined)
        );
        if (mtime) {
          fs.utimesSync(file, mtime, mtime);
          reply.header("X-OC-MTime", "accepted");
        }
        reply.header("ETag", etagOf(fs.statSync(file)));
        return reply.code(existed ? 204 : 201).send();
      }

      case "GET":
      case "HEAD": {
        const stat = statOf(file);
        if (!stat) return reply.code(404).send();
        reply.header("Last-Modified", stat.mtime.toUTCString());
        if (stat.isDirectory()) return reply.code(200).type("text/plain").send(request.method === "HEAD" ? undefined : "collection");
        reply.header("ETag", etagOf(stat));
        reply.header("Content-Length", stat.size);
        reply.type("application/octet-stream");
        if (request.method === "HEAD") return reply.code(200).send();
        return reply.code(200).send(fs.createReadStream(file));
      }

      case "MOVE":
      case "COPY": {
        await readSmallBody(request);
        const destination = destinationPath(request.headers.destination as string | undefined);
        n.destination = destination ?? undefined;
        if (!destination || destination === "/") return reply.code(400).send("Bad Destination");
        const source = statOf(file);
        if (!source) return reply.code(404).send();
        const destinationFile = absolute(destination);
        const exists = Boolean(statOf(destinationFile));
        const overwrite = String(request.headers.overwrite ?? "T").toUpperCase() !== "F";
        if (exists && !overwrite) return reply.code(412).send();
        if (!statOf(path.dirname(destinationFile))?.isDirectory()) return reply.code(409).send();
        if (exists) fs.rmSync(destinationFile, { recursive: true, force: true });
        if (request.method === "MOVE") fs.renameSync(file, destinationFile);
        else fs.cpSync(file, destinationFile, { recursive: true });
        return reply.code(exists ? 204 : 201).send();
      }

      case "DELETE": {
        await readSmallBody(request);
        if (!options.allowDelete) return reply.code(403).send("Deleting is off in this spike");
        if (target === "/") return reply.code(403).send();
        if (!statOf(file)) return reply.code(404).send();
        fs.rmSync(file, { recursive: true, force: true });
        return reply.code(204).send();
      }

      case "LOCK": {
        await readSmallBody(request);
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
        return reply.code(204).send();

      default:
        return reply.code(405).send();
    }
  };

  // The phone's first backup is thousands of requests in a few minutes; the global
  // per-IP limit would answer 429 and muddy what the spike is meant to observe.
  // Phase 1 replaces this with a per-token limit.
  // HEAD is answered by the handler itself, not Fastify's automatic GET twin.
  const routeOptions = { config: { rateLimit: false }, exposeHeadRoute: false } as const;
  for (const url of [SPIKE_PREFIX, `${SPIKE_PREFIX}/`, `${SPIKE_PREFIX}/*`]) {
    app.route({ method: ALL_METHODS, url, ...routeOptions, handler });
  }
  app.log.warn(`Photo Sync SPIKE is on: WebDAV at ${SPIKE_PREFIX}/, files and log in ${options.dir}`);
}
