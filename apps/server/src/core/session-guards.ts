// Rules a module adds to every signed-in request, run by app.authenticate once
// it knows who is asking (auth.ts). A guard answers null to let the request on,
// or the words of a 403 to refuse it.
//
// Platform infrastructure only: it knows nothing about what a guard checks. The
// viewing profiles (modules/profiles) are the first user — a TV in Kids is
// refused the sections Kids leaves out, whatever route the request is for.
import type { FastifyRequest } from "fastify";

export type SessionGuard = (request: FastifyRequest) => string | null;

const guards: SessionGuard[] = [];

export function addSessionGuard(guard: SessionGuard): void {
  if (!guards.includes(guard)) guards.push(guard);
}

/** The first refusal any guard gives, or null. */
export function sessionGuardRefusal(request: FastifyRequest): string | null {
  for (const guard of guards) {
    const refusal = guard(request);
    if (refusal) return refusal;
  }
  return null;
}
