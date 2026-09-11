import type { FastifyError, FastifyInstance } from "fastify";

// The last stop for anything a route or hook throws.
//
// Errors that already carry a client status (4xx) are the client's problem, not
// the server's, and must reach the client as that status: @fastify/rate-limit
// delivers its verdict by throwing a 429 (with retry-after already set on the
// reply), Fastify throws 413 for an oversized body, 400 for malformed JSON or a
// schema validation failure, 415 for an unknown content type — and the app's own
// *Error classes carry a statusCode for the same reason. Flattening those into a
// 500 made the limiter invisible to the web app (nothing to back off from) and
// logged every rejected request of an abuse sweep at `error`.
//
// Anything else is a real fault: log it with its stack and answer a generic 500
// that never leaks the message.
export function clientStatusOf(error: unknown): number | null {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500) return status;
  if ((error as { validation?: unknown } | null)?.validation) return 400;
  return null;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = clientStatusOf(error);
    if (status !== null) {
      // A 429 is routine under the limiter and already visible in the request's own
      // "request completed" line; logging it again would just re-flood the log.
      if (status !== 429) request.log.warn({ err: error, statusCode: status }, error.message);
      return reply.code(status).send({ error: error.message || "Bad request" });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "Unexpected server error" });
  });
}
