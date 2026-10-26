// The gateway to the containers beside this server (docs/apps-platform-plan.md;
// the contract itself is docs/games-platform-plan.md → The contract).
//
// A container never faces the network. This server proxies everything under its
// prefix to it and, on each request, says who is asking: the session is validated
// here exactly as for any route (authenticate — so MFA, trusted networks, rate
// limits, blocks and "preview as member" all apply), then the member's identity
// rides along in X-Isputnik-* headers signed with the container's shared secret.
// Any X-Isputnik-* header the client itself sent is dropped first, so nobody can
// pose as this gateway from outside.
//
// What is particular to one container — games' guests, its own log lines — comes
// in through GatewayHooks; everything here is the same for every one of them.
//
// CSRF: the double-submit hook on the root runs for proxied requests too, so a
// container's front end echoes this app's CSRF cookie on its state-changing calls.
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import httpProxy from "@fastify/http-proxy";
import type { User } from "../../db.js";
import { appRole, networkClass, ruleAllows, ruleFor, type AppRole, type NetworkClass } from "./access.js";
import { capabilityFor, type AppDefinition, type NetworkRule } from "./registry.js";

export const GATEWAY_HEADER = "x-isputnik-gateway";
const IDENTITY_PREFIX = "x-isputnik-";

/** What a container's log needs beyond who: where from, and which request.
 *  The address is request.ip (so it honours this server's proxy trust); the id is
 *  this server's request id, so the two servers' log lines for one request match. */
export interface ForwardedRequest {
  ip: string;
  requestId: string;
}

export function forwardedFrom(request: FastifyRequest): ForwardedRequest {
  return { ip: request.ip, requestId: String(request.id) };
}

/** The headers that tell a container who is signed in. The display name is
 *  percent-encoded: header values are Latin-1 and the family's names are not. */
export function identityHeaders(user: User, secret: string, forwarded: ForwardedRequest): Record<string, string> {
  return {
    [GATEWAY_HEADER]: secret,
    "x-isputnik-user-id": user.id,
    "x-isputnik-user-name": encodeURIComponent(user.display_name),
    "x-isputnik-user-role": user.role,
    "x-isputnik-user-lang": user.language,
    "x-isputnik-user-theme": user.theme,
    "x-isputnik-client-ip": forwarded.ip,
    "x-isputnik-request-id": forwarded.requestId
  };
}

/** Every header except the ones only this gateway may set. */
export function stripIdentityHeaders<T extends Record<string, unknown>>(headers: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(headers) as (keyof T)[]) {
    if (String(key).toLowerCase().startsWith(IDENTITY_PREFIX)) continue;
    out[key] = headers[key];
  }
  return out;
}

/** A browser opening one of the container's PAGES (a bookmark, the installed
 *  app's icon) rather than its front end calling the API. The API keeps the 401
 *  so the front end can say "signed out"; a page gets the sign-in screen. */
export function isPageNavigation(request: FastifyRequest, prefix: string): boolean {
  if (request.method !== "GET") return false;
  if (request.url.startsWith(`${prefix}/api/`)) return false;
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html");
}

/** Where to send a signed-out page navigation: the sign-in screen, which brings
 *  them back here afterwards (LoginPage reads `next`). Only the path, so the
 *  value can never point off this origin. */
export function signInHref(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

/** What one container adds to the shared gateway. */
export interface GatewayHooks {
  /** Asked before the session check, for someone with no session. "admit" lets
   *  the request through without one (identityFor then says who it is),
   *  "answered" means the hook replied itself, "authenticate" goes on as usual. */
  admitWithoutSession?: (request: FastifyRequest, reply: FastifyReply) => "admit" | "answered" | "authenticate";
  /** The identity headers for a request admitted without a session. */
  identityFor?: (request: FastifyRequest, secret: string, forwarded: ForwardedRequest) => Record<string, string>;
  /** Called as each proxied request finishes, with the status the browser got. */
  onResponse?: (request: FastifyRequest, statusCode: number) => void;
  /** Headers of the container's own beside the identity — an engine is told
   *  which of its libraries the person may see (X-Isputnik-Libraries). Only
   *  X-Isputnik-* names; anything else is ignored. */
  extraHeaders?: (request: FastifyRequest) => Record<string, string>;
}

/** What the gateway decided about a request, and tells the container beside who. */
export interface AccessVerdict {
  /** The person's role in this container; null for someone a hook admitted (a guest). */
  role: AppRole | null;
  via: "session" | "guest";
  network: NetworkClass;
}

/** The headers that carry the verdict (docs/apps-platform-plan.md → The contract). */
export function verdictHeaders(verdict: AccessVerdict): Record<string, string> {
  return {
    ...(verdict.role ? { "x-isputnik-app-role": verdict.role } : {}),
    "x-isputnik-via": verdict.via,
    "x-isputnik-network": verdict.network
  };
}

/** A refused request's answer: what is refused and why, in words a page can show. */
function networkRefusal(rule: NetworkRule): string {
  return rule === "trusted"
    ? "This works only from a trusted network."
    : "This works only from the home network.";
}

export interface AppGatewayOptions {
  app: AppDefinition;
  /** The container, e.g. http://isputnik-games:4200. */
  upstream: string;
  /** Asked on every request, so a secret paired on Apps → Setup works at once. */
  secret: string | (() => string);
  /** Asked on every request: false while the admin has the container's section
   *  off, and the whole prefix answers 404 as if it were not installed. */
  available?: () => boolean;
  /** Whether the container draws pages of its own: only then does a signed-out
   *  page navigation go to the sign-in screen instead of a 401. */
  hasPages?: boolean;
  hooks?: GatewayHooks;
}

export async function registerAppGateway(app: FastifyInstance, options: AppGatewayOptions): Promise<void> {
  const { hooks = {} } = options;
  const definition = options.app;
  const prefix = definition.prefix;
  // Its own scope, so the hooks below see only what goes through the proxy.
  await app.register(async (scope) => {
    // authenticate has already written its 401 by the time it returns, so the
    // redirect for a page navigation is applied as the reply leaves: a signed-out
    // person opening a page from a bookmark or the installed app lands on the
    // sign-in screen instead of a line of JSON. API calls keep the 401.
    if (options.hasPages !== false) {
      scope.addHook("onSend", async (request, reply, payload) => {
        if (reply.statusCode !== 401 || !isPageNavigation(request, prefix)) return payload;
        reply.code(302).header("location", signInHref(request.url)).removeHeader("content-type");
        return "";
      });
    }
    if (hooks.onResponse) {
      const onResponse = hooks.onResponse;
      scope.addHook("onResponse", async (request, reply) => {
        onResponse(request, reply.statusCode);
      });
    }

    const verdicts = new WeakMap<FastifyRequest, AccessVerdict>();

    /** Who may, and from where: false once the reply has been sent. Someone with
     *  no role gets 404 — the container is not there for them, as when its
     *  section is off — and a refused network a 403 that says why. */
    const authorize = (request: FastifyRequest, reply: FastifyReply, via: AccessVerdict["via"]): boolean => {
      const role = via === "session" ? appRole(definition.id, request.user!) : null;
      if (via === "session" && !role) {
        void reply.code(404).send({ error: "Not found" });
        return false;
      }
      const network = networkClass(request);
      const capability = capabilityFor(definition, request.url);
      const rule = ruleFor(definition, capability);
      if (!ruleAllows(rule, network)) {
        void reply.code(403).send({ error: networkRefusal(rule), capability: capability.id, rule });
        return false;
      }
      verdicts.set(request, { role, via, network });
      return true;
    };

    await scope.register(httpProxy, {
      upstream: options.upstream,
      prefix,
      rewritePrefix: prefix,
      // Only a signed-in member the container's access admits — or whoever a hook
      // admits — reaches the container; anonymous gets this app's 401.
      // The proxy's hook is callback-style, so the async decorator is adapted: once
      // authenticate has replied 401, Fastify sees the sent reply and never proxies.
      preHandler: (request, reply, done) => {
        // Answered from the hook: no done() after a send (Fastify stops here).
        if (options.available && !options.available()) {
          void reply.code(404).send({ error: "Not found" });
          return;
        }
        const decision = hooks.admitWithoutSession?.(request, reply) ?? "authenticate";
        if (decision === "answered") return;
        if (decision === "admit") {
          if (authorize(request, reply, "guest")) done();
          return;
        }
        app.authenticate(request, reply).then(() => {
          if (reply.sent) return done();
          if (authorize(request, reply, "session")) done();
        }, (err: Error) => done(err));
      },
      replyOptions: {
        rewriteRequestHeaders: (proxied, headers): IncomingHttpHeaders => {
          // The proxy types its request for HTTP/2 as well; this server is HTTP/1,
          // and it is the same request the preHandler above saw.
          const request = proxied as unknown as FastifyRequest;
          const forwarded = forwardedFrom(request);
          const verdict = verdicts.get(request);
          const secret = typeof options.secret === "function" ? options.secret() : options.secret;
          const identity = verdict?.via === "guest" && hooks.identityFor
            ? hooks.identityFor(request, secret, forwarded)
            : identityHeaders(request.user!, secret, forwarded);
          const extra = Object.fromEntries(Object.entries(hooks.extraHeaders?.(request) ?? {})
            .filter(([name]) => name.toLowerCase().startsWith(IDENTITY_PREFIX)));
          return { ...stripIdentityHeaders(headers as IncomingHttpHeaders), ...identity, ...(verdict ? verdictHeaders(verdict) : {}), ...extra };
        }
      }
    });
  });
}
