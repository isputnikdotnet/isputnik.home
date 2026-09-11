// The Fastify app most route tests want: cookies, the real auth decorators
// (authenticate / requireAdmin reading real session rows), the plugins under test,
// and a way to sign someone in without going through the password flow — which has
// its own tests (login-failure-reason, password-*, mfa-*).
//
//   let app: FastifyInstance;
//   let signIn: (userId: string) => Promise<string>;
//   beforeEach(async () => {
//     resetDb();
//     ({ app, signIn } = await bootApp({ plugins: [notesPlugin] }));
//   });
//   ...
//   await app.inject({ method: "GET", url: "/api/x", headers: { cookie: await signIn("dad") } });
//
// Signing in calls issueSession from a request to a small app of the helper's own,
// beside the one under test, over the same database. The session row carries that
// request's user agent and address exactly as a real sign-in would, and the app
// under test gains no route, hook or request it didn't ask for — a test counting
// its routes, or its activity log, sees only its own.
//
// The src modules are imported when bootApp runs, not when this file loads. A suite
// that calls vi.resetModules() to reload config against a fresh DB_PATH (the backup
// tests) gets decorators that read the same fresh database its own imports see.
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyPluginCallback,
  type FastifyServerOptions,
  type InjectOptions,
  type LightMyRequestResponse
} from "fastify";
import cookie from "@fastify/cookie";
import type { SessionOptions } from "../../src/auth.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugins take their own option shapes
type Plugin = FastifyPluginAsync<any> | FastifyPluginCallback<any>;
/** A plugin, or a plugin with the options it is registered with. */
export type PluginEntry = Plugin | [Plugin, Record<string, unknown>];

export interface BootOptions {
  /** Registered in order, after the auth decorators. */
  plugins?: PluginEntry[];
  /** Runs after cookies, CSRF and the auth decorators, before the plugins: root
   *  hooks as index.ts adds them, extra routes, seeding a plugin reads on register. */
  beforeRegister?: (app: FastifyInstance) => unknown;
  /** Runs after the plugins, before ready(): extra routes, non-plugin registrars. */
  afterRegister?: (app: FastifyInstance) => unknown;
  /** Adds the double-submit CSRF hook on the root before anything else, as
   *  index.ts does. `true` uses core/csrf.ts; a function is used instead of it. */
  csrf?: boolean | ((app: FastifyInstance) => void);
  /** Options for Fastify() itself (trustProxy, bodyLimit, …). */
  fastify?: FastifyServerOptions;
}

export interface SignInOptions extends SessionOptions {
  /** Headers on the sign-in request (user-agent, …), recorded on the session row. */
  headers?: Record<string, string>;
  /** The address the sign-in comes from (inject's default is 127.0.0.1). */
  remoteAddress?: string;
}

export interface TestSession {
  /** The new session's id (sessions.id). */
  id: string;
  /** Cookie header value: the session cookie, plus a CSRF cookie when csrf is on. */
  cookie: string;
  /** Ready-made request headers: cookie, and x-csrf-token when csrf is on. */
  headers: Record<string, string>;
}

type Caller = (url: string, payload?: InjectOptions["payload"], headers?: Record<string, string>) =>
  Promise<LightMyRequestResponse>;

export interface BootedApp {
  app: FastifyInstance;
  /** Signs `userId` in through issueSession; resolves to the Cookie header value. */
  signIn(userId: string, opts?: SignInOptions): Promise<string>;
  /** Same as signIn, with the session id and ready-made headers as well. */
  session(userId: string, opts?: SignInOptions): Promise<TestSession>;
  /** Requests as whoever holds `cookie` (anonymous when omitted), adding the CSRF
   *  header when csrf is on. */
  as(cookie?: string): Record<"get" | "post" | "put" | "patch" | "delete", Caller>;
}

/** Every name=value pair a response set, as one Cookie header value. */
export function cookiesFrom(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [String(raw)];
  return list.map((entry) => entry.split(";")[0]).join("; ");
}

/** The session cookie (`isputnik_sid=…`) a response — or its headers — set, ready
 *  to send back; throws when it set none. */
export function sessionCookieFrom(source: LightMyRequestResponse | Record<string, unknown>): string {
  const headers = "statusCode" in source && "raw" in source
    ? (source as LightMyRequestResponse).headers
    : (source as Record<string, unknown>);
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid=") || entry.startsWith("__Host-isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

function csrfTokenIn(cookieHeader: string | undefined): string | undefined {
  return cookieHeader?.match(/(?:^|;\s*)(?:__Host-)?isputnik_csrf=([^;]+)/)?.[1];
}

export async function bootApp(options: BootOptions = {}): Promise<BootedApp> {
  const { registerAuthDecorators, issueSession } = await import("../../src/auth.js");

  const app = Fastify(options.fastify);
  await app.register(cookie);
  let csrfCookie: string | null = null;
  if (options.csrf) {
    const csrf = await import("../../src/core/csrf.js");
    const { config } = await import("../../src/config.js");
    (typeof options.csrf === "function" ? options.csrf : csrf.registerCsrf)(app);
    csrfCookie = csrf.csrfCookieName(config.cookieSecure);
  }
  await registerAuthDecorators(app);
  await options.beforeRegister?.(app);
  for (const entry of options.plugins ?? []) {
    if (Array.isArray(entry)) await app.register(entry[0], entry[1]);
    else await app.register(entry);
  }
  await options.afterRegister?.(app);

  // The sign-in desk: its own app, so the one under test stays exactly as built.
  const desk = Fastify();
  await desk.register(cookie);
  desk.get("/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const raw = (request.query as { opts?: string }).opts;
    const id = issueSession(reply, userId, request, raw ? (JSON.parse(raw) as SessionOptions) : {});
    return reply.send({ id });
  });
  await desk.ready();
  app.addHook("onClose", async () => { await desk.close(); });

  await app.ready();

  async function session(userId: string, opts: SignInOptions = {}): Promise<TestSession> {
    const { headers, remoteAddress, ...sessionOpts } = opts;
    const query = Object.keys(sessionOpts).length ? `?opts=${encodeURIComponent(JSON.stringify(sessionOpts))}` : "";
    const res = await desk.inject({ method: "GET", url: `/${encodeURIComponent(userId)}${query}`, headers, remoteAddress });
    if (res.statusCode !== 200) throw new Error(`test sign-in failed (${res.statusCode}): ${res.body}`);
    const sid = sessionCookieFrom(res);
    const id = (res.json() as { id: string }).id;
    if (!csrfCookie) return { id, cookie: sid, headers: { cookie: sid } };
    // The double-submit check only asks that header and cookie match, which is what
    // the SPA sends after picking the cookie up on its first GET.
    const { nanoid } = await import("nanoid");
    const token = nanoid(32);
    const cookieHeader = `${sid}; ${csrfCookie}=${token}`;
    return { id, cookie: cookieHeader, headers: { cookie: cookieHeader, "x-csrf-token": token } };
  }

  function as(cookieHeader?: string) {
    const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Caller => (url, payload, headers = {}) => {
      const token = csrfCookie ? csrfTokenIn(cookieHeader) : undefined;
      return app.inject({
        method,
        url,
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          ...(token ? { "x-csrf-token": token } : {}),
          ...headers
        },
        ...(payload === undefined ? {} : { payload })
      });
    };
    return { get: call("GET"), post: call("POST"), put: call("PUT"), patch: call("PATCH"), delete: call("DELETE") };
  }

  return {
    app,
    signIn: async (userId, opts) => (await session(userId, opts)).cookie,
    session,
    as
  };
}
