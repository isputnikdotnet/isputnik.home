import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";

// Response compression for JSON and text.
//
// WHY THIS IS HAND-ROLLED AND SYNCHRONOUS
//
// @fastify/compress was the obvious choice and it silently truncated responses.
// Its onSend hook returns a stream, and 847 handlers in this codebase are of the
// form:
//
//     app.get("/x", async (request, reply) => { reply.send(payload); });
//
// Fastify requires an async handler that calls reply.send() to also `return
// reply` — otherwise the handler's promise resolves to undefined while the send
// is still in flight, and Fastify finalises the response over the top of it. The
// client gets 200, `content-encoding: br`, `content-length: 0`, and an empty
// body. Nothing warns; the response just arrives empty.
//
// That is a latent bug in those handlers, not in the library, but it only shows
// once any asynchronous onSend hook exists — and it shows on every response over
// the threshold, which is most of the interesting ones. Fixing it properly means
// touching 847 call sites across 45 files, several of them behind send-helpers,
// in the middle of a performance pass. Worth doing; not worth doing blind.
//
// So compression happens synchronously instead. The whole send completes in the
// same tick as reply.send(), before the handler's promise resolves, so there is
// nothing for Fastify to race. Measured on this machine, brotli quality 4:
//
//     122 KB -> 0.6 ms      618 KB -> 1.9 ms      2.5 MB -> 8.7 ms
//
// against ratios of 23-36x on catalogue JSON. Blocking the loop for a
// millisecond to avoid sending thirty times the bytes is the right trade on a
// box that is usually waiting on a disk anyway. Quality 4 rather than zlib's
// default 11 for the same reason as before: 11 is tuned for compress-once static
// assets and costs far more CPU than it saves per request.
//
// Deliberately NOT handled here: streams. Audio, video, file downloads and
// backups either hijack the reply (bypassing onSend entirely) or arrive as a
// stream, and both fall through untouched — they are already compressed formats.

/** Below this, framing overhead outweighs the saving. */
const THRESHOLD_BYTES = 1024;

// Compressible by content type. JSON and text only: everything this server sends
// that is already compressed (jpeg/webp covers, audio, video, zip backups) is
// absent, so it is never spent CPU on for nothing.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|manifest\+json|x-ndjson)|image\/svg\+xml)/i;

function pickEncoding(accept: string): "br" | "gzip" | null {
  // Weighted Accept-Encoding ("gzip;q=0.5, br;q=0") is rare from browsers, but a
  // q=0 means "not acceptable" and must be honoured rather than matched on name.
  const offers = accept.toLowerCase().split(",").map((part) => {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { name: name.trim(), q: q ? Number(q.slice(2)) : 1 };
  });
  const wants = (name: string) => offers.some((o) => (o.name === name || o.name === "*") && o.q > 0);
  if (wants("br")) return "br";
  if (wants("gzip")) return "gzip";
  return null;
}

function compress(buf: Buffer, encoding: "br" | "gzip"): Buffer {
  return encoding === "br"
    ? brotliCompressSync(buf, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 4,
        // Telling brotli the exact input size lets it size its window instead of
        // assuming the worst, which is free and slightly smaller.
        [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length
      }
    })
    : gzipSync(buf, { level: 6 });
}

export function registerCompression(app: FastifyInstance): void {
  app.addHook("onSend", (request: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    // Streams, nulls and anything exotic pass through. So does a payload that
    // some route already encoded itself.
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return done(null, payload as never);
    if (reply.getHeader("content-encoding")) return done(null, payload as never);

    // 204/304 carry no body, and a HEAD reply must keep the headers it would
    // have had with a body — compressing an empty payload would lie about both.
    const status = reply.statusCode;
    if (request.method === "HEAD" || status === 204 || status === 304) return done(null, payload as never);

    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    if (buf.length < THRESHOLD_BYTES) return done(null, payload as never);

    const type = String(reply.getHeader("content-type") ?? "");
    if (!COMPRESSIBLE.test(type)) return done(null, payload as never);

    const encoding = pickEncoding(String(request.headers["accept-encoding"] ?? ""));
    if (!encoding) return done(null, payload as never);

    let out: Buffer;
    try {
      out = compress(buf, encoding);
    } catch {
      // A compression failure must cost the saving, not the response.
      return done(null, payload as never);
    }

    // Vary matters even on a LAN: a caching proxy that stored the brotli copy
    // must not hand it to a client that never asked for one.
    reply.header("vary", appendVary(String(reply.getHeader("vary") ?? ""), "accept-encoding"));
    reply.header("content-encoding", encoding);
    reply.header("content-length", out.length);
    // An entity tag identifies a representation, and this is now a different
    // one. Suffixing keeps conditional requests working per encoding instead of
    // letting a client match the identity tag against compressed bytes.
    const etag = reply.getHeader("etag");
    if (typeof etag === "string") reply.header("etag", etag.replace(/"$/, `-${encoding}"`));
    done(null, out as never);
  });
}

function appendVary(existing: string, field: string): string {
  const parts = existing.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === field)) return existing;
  return [...parts, field].join(", ");
}
