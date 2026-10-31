// Who may use each container, and from where (docs/apps-platform-plan.md →
// Access, Network rules). Control panel → Security › App access edits both; the gateway
// asks both on every request.
//
// Who: the unified `assignments` table with object_type 'app' and the container's
// id — Everyone, groups or people, as `member` (use it) or `manager` (look after
// it: the games' admin window, video's fix-match), or `deny`. Administrators are
// always managers. A container nobody has set up access for behaves as it always
// did: everyone signed in is a member. The first change on Security › App access writes
// that baseline down, so taking Everyone away later really takes it away.
//
// From where: one rule per capability (registry.ts), kept in app_settings.
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { EVERYONE_GROUP_ID, resolveObjectRole } from "../../core/permissions.js";
import { hasForwardedHeader, isProxyTrustConfigured, isTrustedIp } from "../../core/security.js";
import { isPrivateIp } from "../../core/cidr.js";
import type { AppSettingRow, AssignmentRow } from "../../db/rows.js";
import { NETWORK_RULES, type AppCapability, type AppDefinition, type AppId, type NetworkRule } from "./registry.js";

export const APP_OBJECT_TYPE = "app";

export type AppRole = "member" | "manager";
export const APP_GRANT_ROLES = ["member", "manager", "deny"] as const;
export type AppGrantRole = (typeof APP_GRANT_ROLES)[number];

/** How the gateway judged where a request came from, as the container is told
 *  (X-Isputnik-Network) so it can hide what a rule would refuse anyway. */
export type NetworkClass = "trusted" | "home" | "internet";

// ── Stored settings ──────────────────────────────────────────────────────────

const SETTINGS_KEY = "apps";

const settingsSchema = z.object({
  /** Containers whose access has been set on Security › App access at least once. */
  accessConfigured: z.array(z.string()).default([]),
  /** Per container, per capability: the rule an admin chose. */
  rules: z.record(z.string(), z.record(z.string(), z.enum(NETWORK_RULES))).default({})
});
type AppsSettings = z.infer<typeof settingsSchema>;

function readSettings(): AppsSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTINGS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return settingsSchema.parse({});
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : settingsSchema.parse({});
  } catch {
    return settingsSchema.parse({});
  }
}

function writeSettings(next: AppsSettings, updatedBy: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(SETTINGS_KEY, JSON.stringify(next), updatedBy);
}

// ── Who ──────────────────────────────────────────────────────────────────────

function accessConfigured(appId: AppId): boolean {
  return readSettings().accessConfigured.includes(appId);
}

/** The person's role in the container, or null: no access (the prefix answers 404). */
export function appRole(appId: AppId, user: { id: string; role: string }): AppRole | null {
  if (user.role === "admin") return "manager";
  if (!accessConfigured(appId)) return "member";
  const role = resolveObjectRole(APP_OBJECT_TYPE, appId, user);
  if (!role) return null;
  return role === "manager" ? "manager" : "member";
}

/** Before the first change, write the baseline every container has had —
 *  Everyone as members — so the change is made on top of it, not of nothing. */
function ensureConfigured(appId: AppId, userId: string): void {
  const settings = readSettings();
  if (settings.accessConfigured.includes(appId)) return;
  db.prepare(`
    INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
    VALUES ('group', ?, ?, ?, 'member', ?)
    ON CONFLICT (subject_type, subject_id, object_type, object_id) DO NOTHING
  `).run(EVERYONE_GROUP_ID, APP_OBJECT_TYPE, appId, userId);
  writeSettings({ ...settings, accessConfigured: [...settings.accessConfigured, appId] }, userId);
}

export interface AppGrant {
  subjectType: "user" | "group";
  subjectId: string;
  role: AppGrantRole;
  name: string;
  email: string | null;
  missing: boolean;
}

/** Everyone's role and the explicit grants, as Security › App access shows them. */
export function listAppAccess(appId: AppId): { everyone: AppRole | null; grants: AppGrant[] } {
  if (!accessConfigured(appId)) return { everyone: "member", grants: [] };
  const rows = db.prepare(`
    SELECT
      a.subject_type, a.subject_id, a.role,
      CASE a.subject_type WHEN 'user' THEN u.display_name ELSE g.name END AS name,
      CASE a.subject_type WHEN 'user' THEN u.email ELSE NULL END AS email,
      CASE
        WHEN a.subject_type = 'user' AND u.id IS NULL THEN 1
        WHEN a.subject_type = 'group' AND g.id IS NULL THEN 1
        ELSE 0
      END AS missing
    FROM assignments a
    LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
    LEFT JOIN user_groups g ON a.subject_type = 'group' AND g.id = a.subject_id
    WHERE a.object_type = ? AND a.object_id = ?
    ORDER BY a.subject_type, name COLLATE NOCASE
  `).all(APP_OBJECT_TYPE, appId) as (Pick<AssignmentRow, "subject_type" | "subject_id" | "role"> & { name: string | null; email: string | null; missing: number })[];

  const everyoneRow = rows.find((row) => row.subject_type === "group" && row.subject_id === EVERYONE_GROUP_ID);
  const everyone = everyoneRow && everyoneRow.role !== "deny" ? (everyoneRow.role === "manager" ? "manager" : "member") : null;
  return {
    everyone,
    grants: rows
      .filter((row) => row !== everyoneRow)
      .map((row) => ({
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        role: row.role === "deny" || row.role === "manager" ? row.role : "member",
        name: row.name ?? "(deleted)",
        email: row.email,
        missing: Boolean(row.missing)
      }))
  };
}

/** Everyone's baseline: a role, or null for nobody but the grants. */
export function setEveryoneAppRole(appId: AppId, role: AppRole | null, userId: string): void {
  ensureConfigured(appId, userId);
  if (role === null) {
    db.prepare("DELETE FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = ? AND object_id = ?")
      .run(EVERYONE_GROUP_ID, APP_OBJECT_TYPE, appId);
    return;
  }
  grantAppRole(appId, "group", EVERYONE_GROUP_ID, role, userId);
}

export function grantAppRole(appId: AppId, subjectType: "user" | "group", subjectId: string, role: AppGrantRole, userId: string): void {
  ensureConfigured(appId, userId);
  db.prepare(`
    INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (subject_type, subject_id, object_type, object_id)
    DO UPDATE SET role = excluded.role, created_by = excluded.created_by
  `).run(subjectType, subjectId, APP_OBJECT_TYPE, appId, role, userId);
}

export function revokeAppRole(appId: AppId, subjectType: "user" | "group", subjectId: string, userId: string): boolean {
  ensureConfigured(appId, userId);
  return db.prepare("DELETE FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?")
    .run(subjectType, subjectId, APP_OBJECT_TYPE, appId).changes > 0;
}

// ── From where ───────────────────────────────────────────────────────────────

export function ruleFor(app: AppDefinition, capability: AppCapability): NetworkRule {
  return readSettings().rules[app.id]?.[capability.id] ?? capability.defaultRule;
}

export function rulesFor(app: AppDefinition): Record<string, NetworkRule> {
  return Object.fromEntries(app.capabilities.map((cap) => [cap.id, ruleFor(app, cap)]));
}

export function setRule(app: AppDefinition, capabilityId: string, rule: NetworkRule, userId: string): boolean {
  if (!app.capabilities.some((cap) => cap.id === capabilityId)) return false;
  const settings = readSettings();
  const rules = { ...settings.rules, [app.id]: { ...(settings.rules[app.id] ?? {}), [capabilityId]: rule } };
  writeSettings({ ...settings, rules }, userId);
  return true;
}

/** Whether the address can be believed at all: behind a proxy whose trust is not
 *  configured, request.ip is the proxy's own (often private) address, and every
 *  rule keyed on it would let the whole internet through. Judged per request,
 *  as core/security.ts does for its own exemptions. */
function addressBelievable(request: FastifyRequest): boolean {
  return !(hasForwardedHeader(request.headers as Record<string, unknown>) && !isProxyTrustConfigured());
}

export function networkClass(request: FastifyRequest): NetworkClass {
  if (!addressBelievable(request)) return "internet";
  if (isTrustedIp(request.ip)) return "trusted";
  if (isPrivateIp(request.ip)) return "home";
  return "internet";
}

/** Whether a request from this network may use a capability under this rule.
 *  "home" admits the trusted zones too: a trusted network is at least as close. */
export function ruleAllows(rule: NetworkRule, network: NetworkClass): boolean {
  if (rule === "anywhere") return true;
  if (rule === "trusted") return network === "trusted";
  return network === "trusted" || network === "home";
}
