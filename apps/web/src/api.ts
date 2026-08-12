export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  theme: "system" | "light" | "dark" | "plain-light" | "plain-dark" | "expanse";
  protectedFromDelete: boolean;
  isActive: boolean;
  createdAt: string;
  deletedAt: string | null;
  // Self-only: present on the signed-in user (session + profile), absent on the
  // admin user list. Used by Send-to-e-reader and the Profile field.
  ereaderEmail?: string | null;
  // Whether two-factor is on. Self-only on the session/profile payload; also
  // surfaced on the admin user list so an admin can reset a locked-out member.
  mfaEnabled?: boolean;
  // Which second factor the account uses — a code from an authenticator app, or
  // one emailed at sign-in. Only meaningful when mfaEnabled is true.
  mfaMethod?: MfaMethod;
}

export type MfaMethod = "totp" | "email";

interface ApiErrorPayload {
  error?: string;
  details?: {
    fieldErrors?: Record<string, string[]>;
    formErrors?: string[];
  };
}

export class ApiError extends Error {
  status: number;

  /** The parsed error body, for the routes that send more than a sentence — a refused
   *  duplicate deletion returns which copies moved and why, and the page can only say
   *  so if the payload survives being turned into an Error. */
  body: unknown;

  /** This reply was written by something between the browser and the server — a
   *  corporate proxy, a content filter, a captive portal — not by iSputnik. */
  blockedByNetwork: boolean;

  constructor(message: string, status: number, body?: unknown, blockedByNetwork = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.blockedByNetwork = blockedByNetwork;
  }
}

// Statuses a security gateway hands back when it refuses to pass a request on:
// 403 (blocked / caution page — what Zscaler returns for an uncategorised host),
// 407 (proxy wants credentials), 451 (blocked for legal reasons), 511 (captive
// portal wants a sign-in). Our own 403s — CSRF, permissions — are JSON, which is
// what tells the two apart.
const GATEWAY_STATUSES = [403, 407, 451, 511];

/** Whether an /api reply came from a middlebox rather than from iSputnik. Every JSON
 *  route answers in JSON even when it fails, so a gateway status carrying HTML (or no
 *  content type at all) means someone else wrote this reply. Worth naming: a filtered
 *  request looks exactly like a broken app from the inside — the sign-in call fails,
 *  the server looks down — and the user can spend an evening blaming the wrong thing. */
export function isBlockedByNetwork(response: Response): boolean {
  if (response.ok) return false;
  if (!GATEWAY_STATUSES.includes(response.status)) return false;
  const type = response.headers.get("content-type") ?? "";
  return !type.includes("json");
}

/** What to tell the user when {@link isBlockedByNetwork} says yes. */
export const NETWORK_BLOCK_MESSAGE =
  `Something on this network — a corporate proxy, a content filter, or a guest Wi-Fi portal — ` +
  `answered instead of iSputnik. The server itself is fine. Ask whoever runs the network to allow ` +
  `${window.location.host}, or try a different connection.`;

export function isAccessOrMissingApiError(error: unknown): boolean {
  // A gateway's 403 is not the server saying no — it never reached the server. Callers
  // use this to decide whether an offline copy is still worth showing, and behind a
  // filter it very much is.
  if (error instanceof ApiError && error.blockedByNetwork) return false;
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

// The double-submit CSRF token the server issued as a JS-readable cookie. Echoed
// in the X-CSRF-Token header on every state-changing request (see core/csrf.ts).
// Over HTTPS the server issues it under the __Host- prefix, which pins it to this
// exact origin; on a plain-http LAN it can't (browsers require Secure for that
// prefix) and the bare name is used. Always prefer the prefixed one: right after
// an upgrade both can exist, and echoing the stale bare value would 403 forever.
export function csrfToken(): string {
  const match =
    document.cookie.match(/(?:^|;\s*)__Host-isputnik_csrf=([^;]+)/) ??
    document.cookie.match(/(?:^|;\s*)isputnik_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    if (isBlockedByNetwork(response)) {
      throw new ApiError(NETWORK_BLOCK_MESSAGE, response.status, undefined, true);
    }
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    const fieldMessage = payload.details?.fieldErrors
      ? Object.entries(payload.details.fieldErrors)
          .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
          .join("; ")
      : "";
    const formMessage = payload.details?.formErrors?.join("; ") ?? "";
    throw new ApiError(
      fieldMessage || formMessage || payload.error || "Request failed",
      response.status,
      payload
    );
  }

  return response.json() as Promise<T>;
}
