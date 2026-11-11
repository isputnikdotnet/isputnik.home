import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";

// How fast a device can pull bytes from this server: the TV app's "Test connection
// speed" reads this for a few seconds and times it. The bytes are random, so no
// compression anywhere on the way (a proxy, a VPN) can make the link look faster than
// it is, and they come from one buffer made once, so a test costs the server nothing
// but the sending. Signed-in only and rate-limited: it is a way to make the server
// send a lot, and a stranger has no business doing that.

/** What one request may ask for, and what it gets when it doesn't say. */
export const SPEED_TEST_MAX_BYTES = 100 * 1024 * 1024;
export const SPEED_TEST_DEFAULT_BYTES = 25 * 1024 * 1024;

const CHUNK_BYTES = 1024 * 1024;
let chunk: Buffer | null = null;

function* pieces(total: number): Generator<Buffer> {
  chunk ??= randomBytes(CHUNK_BYTES);
  for (let left = total; left > 0; left -= CHUNK_BYTES) {
    yield chunk.subarray(0, Math.min(left, CHUNK_BYTES));
  }
}

/** The size asked for, held inside what one request may have; anything unreadable is the default. */
export function speedTestBytes(asked: unknown): number {
  const value = typeof asked === "string" && /^\d+$/.test(asked) ? Number(asked) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) return SPEED_TEST_DEFAULT_BYTES;
  return Math.min(value, SPEED_TEST_MAX_BYTES);
}

export async function speedTestPlugin(app: FastifyInstance) {
  app.get(
    "/api/speed-test",
    { preHandler: app.authenticate, logLevel: "warn", config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const total = speedTestBytes((request.query as { bytes?: unknown } | undefined)?.bytes);
      // Streamed by hand, past onSend: compression and the like have nothing to do here.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": total,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      const stream = Readable.from(pieces(total), { objectMode: false });
      // A device that has measured enough hangs up: stop making bytes for it.
      reply.raw.on("close", () => stream.destroy());
      stream.on("error", (err) => reply.raw.destroy(err));
      stream.pipe(reply.raw);
    }
  );
}
