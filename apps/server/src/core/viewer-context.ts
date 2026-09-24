// Who is asking — for code far below a route handler that must shape what it
// returns for the person reading it, without every caller passing the user down.
//
// Every route handler runs inside an AsyncLocalStorage context holding its request
// (registerViewerContext, called with the auth decorators, wraps each handler as
// it is registered). By the time the handler runs, the auth preHandler has set
// request.user, so currentViewer() is the signed-in user, or null for a public
// route or code outside any request (jobs, startup, tests — see runAsViewer).
//
// viewerMemo keeps a value for the rest of one request: a check that a row mapper
// asks thousands of times (which libraries can this viewer open?) is worked out
// once. Outside a request it just computes.
//
// Platform infrastructure only: it knows nothing about what a module asks it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { AuthUser } from "./permissions.js";

interface ViewerStore {
  request?: FastifyRequest;
  user?: AuthUser | null;
  memo: Map<string, unknown>;
}

const store = new AsyncLocalStorage<ViewerStore>();

/** The user the current request is for, or null outside one / before sign-in. */
export function currentViewer(): AuthUser | null {
  const current = store.getStore();
  if (!current) return null;
  if (current.user !== undefined) return current.user;
  const user = current.request?.user;
  return user ? { id: user.id, role: user.role } : null;
}

/** A value computed once per request (per key). Keys are the caller's: prefix
 *  them with the module ("gallery.people:…"). Without a request, computes each time. */
export function viewerMemo<T>(key: string, compute: () => T): T {
  const current = store.getStore();
  if (!current) return compute();
  if (current.memo.has(key)) return current.memo.get(key) as T;
  const value = compute();
  current.memo.set(key, value);
  return value;
}

/** Run `fn` as `user` — for tests and background work that build what a person
 *  would see. Nested calls see the innermost user. */
export function runAsViewer<T>(user: AuthUser | null, fn: () => T): T {
  return store.run({ user, memo: new Map() }, fn);
}

/** Wrap every route registered from here on so its handler runs in a context
 *  that knows its request. Register on the root instance before the plugins. */
export function registerViewerContext(app: FastifyInstance): void {
  app.addHook("onRoute", (routeOptions) => {
    const handler = routeOptions.handler as RouteHandlerMethod;
    routeOptions.handler = function viewerScoped(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      return store.run({ request, memo: new Map() }, () => handler.call(this, request, reply));
    } as RouteHandlerMethod;
  });
}
