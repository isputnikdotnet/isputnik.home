// "Preview as …": an admin sees the app exactly as one member would, read-only
// (docs/people-sharing-plan.md, phase 2).
//
// A session cookie names the member. authenticate() honours it only on an
// ADMIN's ordinary session and only for an active member (never another admin),
// and then puts that member in request.user — so every scope, redaction, face
// filter and thumbnail check the app already has answers as they would, down to
// <img> requests the page never passes a header to. request.previewBy keeps the
// admin who is looking. Anything but a read is refused while it lasts, except
// ending it, and nothing is written to the activity log in the member's name
// (db.ts → logActivity asks isPreviewing()).
//
// Platform infrastructure: it knows nothing about what is being previewed.
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { hostCookieName } from "./cookies.js";

export const PREVIEW_COOKIE = hostCookieName("isputnik_preview", config.cookieSecure);
/** The address that starts and ends a preview (core/auth-routes.ts). */
export const PREVIEW_ROUTE = "/api/preview";

export function previewTargetOf(request: FastifyRequest): string | undefined {
  return request.cookies[PREVIEW_COOKIE] || undefined;
}

/** A browser-session cookie: it ends when the browser closes, or on Stop. */
export function setPreviewCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(PREVIEW_COOKIE, userId, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/"
  });
}

export function clearPreviewCookie(reply: FastifyReply): void {
  reply.clearCookie(PREVIEW_COOKIE, { path: "/" });
}

/** Whether a request under preview may go ahead: reads (GET, or a POST its route
 *  marks previewSafe), ending the preview, and signing out. */
export function previewAllows(request: FastifyRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  // A read that has to carry a body, declared so by its route (types.ts).
  if (request.routeOptions.config?.previewSafe) return true;
  const path = request.url.split("?")[0];
  // Signing out ends the admin's own session, so it is never a write as the member.
  return path === PREVIEW_ROUTE || path === "/api/auth/logout";
}
