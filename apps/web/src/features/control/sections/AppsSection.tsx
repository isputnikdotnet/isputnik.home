import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Boxes, Check, Copy, KeyRound, Link2Off, ScrollText, ShieldCheck, Siren } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, queryParam, replaceQuery } from "../../../router";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl, type AccessCandidate, type AccessRole } from "../../../shared/AccessControl";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectField } from "../../../shared/SelectField";
import { formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";

// Control panel → Apps: the containers beside this server (docs/apps-platform-plan.md).
// Installed says how each one stands; Events and Logs are the admin's window into
// a container, read from it through the gateway with this admin's own session —
// nothing about them is stored here. Read-only by design: where a container is
// and its secret are environment variables on this container (pairing is a later
// phase of the plan), so this shows what they are set to, never the secret.
//
// Today the one container is isputnik.games, and the words on these pages are
// still the games' own; they become per-app when the second container arrives.

/** One container, as GET /api/apps/admin/status answers for it. */
export interface AppStatus {
  id: string;
  kind: "app" | "engine";
  /** Where it answers on this origin: its admin events and log are under it. */
  prefix: string;
  configured: boolean;
  reason: string | null;
  url: string | null;
  secretSet: boolean;
  /** Where the secret in force came from (modules/apps/pairing.ts). */
  secretSource: "environment" | "paired" | "none";
  pairing: { pairedAt: string; pairedBy: string | null } | null;
  /** The variable names Setup quotes: this container's two, and the container's own. */
  variables: { url: string; secret: string; container: string };
  /** Whether the container takes this app's signature; null = not asked or unknown. */
  secretAccepted: boolean | null;
  server: { ok: boolean; version: string | null; error: string | null } | null;
}

type EventLevel = "info" | "warn" | "error";
type LevelFilter = "all" | EventLevel;

interface AppEvent {
  id: number;
  at: string;
  level: EventLevel;
  event: string;
  actorId: string | null;
  actorName: string | null;
  matchId: string | null;
  ip: string | null;
  requestId: string | null;
  detail: string;
}

interface EventsPage {
  events: AppEvent[];
  total: number;
  page: number;
  totalPages: number;
  retentionDays: number;
  rejected24h: number;
}

interface LogTail {
  lines: string[];
  capacity: number;
  available: boolean;
}

/** A guest link, as the server lists it (modules/games/guest-invites.ts) — never the token. */
interface GuestInvite {
  id: string;
  guestName: string;
  game: string;
  matchId: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openedCount: number;
  lastSeenAt: string | null;
  lastIp: string | null;
  state: "live" | "expired" | "revoked" | "pending";
}

const CONFIG_DOC = "https://github.com/isputnikdotnet/isputnik.home/blob/main/docs/configuration.md#games";
const LOG_LINES = 200;

// pino's numeric levels, for the log lines a container hands over raw.
const LEVEL_NAMES: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };

interface PinoLine {
  level?: number;
  time?: number;
  msg?: string;
  reqId?: string;
  user?: string | null;
  ip?: string;
  reason?: string;
  req?: { method?: string; url?: string };
  res?: { statusCode?: number };
  responseTime?: number;
  err?: { message?: string };
}

/** One JSON log line as a line a person reads: time, level, who, what. The raw
 *  line stays for anything that is not pino's JSON (a stack trace, say). */
export function formatLogLine(raw: string): string {
  let line: PinoLine;
  try {
    line = JSON.parse(raw) as PinoLine;
  } catch {
    return raw;
  }
  if (typeof line !== "object" || line === null || typeof line.level !== "number") return raw;
  // Local time, like the events table.
  const time = typeof line.time === "number" ? new Date(line.time).toTimeString().slice(0, 8) : "--:--:--";
  const level = (LEVEL_NAMES[line.level] ?? String(line.level)).padEnd(5);
  const who = [line.reqId ? `[${line.reqId}]` : null, line.user ?? null, line.ip ?? null].filter(Boolean).join(" ");
  let what = line.msg ?? "";
  if (line.req?.method && line.req.url) {
    const status = line.res?.statusCode !== undefined ? ` → ${line.res.statusCode}` : "";
    const took = typeof line.responseTime === "number" ? ` (${Math.round(line.responseTime)} ms)` : "";
    what = `${line.req.method} ${line.req.url}${status}${took}`;
  } else if (line.res?.statusCode !== undefined) {
    const took = typeof line.responseTime === "number" ? ` (${Math.round(line.responseTime)} ms)` : "";
    what = `${line.msg ?? ""} → ${line.res.statusCode}${took}`;
  }
  if (line.reason) what += ` — ${line.reason}`;
  if (line.err?.message) what += ` — ${line.err.message}`;
  return [time, level, who, what].filter(Boolean).join("  ");
}

/** Up, set up and taking our signature: the containers Events and Logs can ask. */
function isRunning(app: AppStatus): boolean {
  return app.configured && Boolean(app.server?.ok) && app.secretAccepted !== false;
}

/** Every container this release knows, with how it stands. */
function useAppsStatus() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [apps, setApps] = useState<AppStatus[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api<{ apps: AppStatus[] }>("/api/apps/admin/status")
        .then((payload) => { setApps(payload.apps); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:apps.loadFailed")); throw err; }),
    [t]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  return { apps, error, load };
}

function useAppName() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  // One name per container this release knows; the registry (modules/apps) has the same list.
  return (id: string) => (id === "games" ? t("common:nav.games") : id);
}

// ── Installed ────────────────────────────────────────────────────────────────

export function AppsInstalledSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const { apps, error, load } = useAppsStatus();

  return (
    <>
      <ControlSectionHead
        section="appsInstalled"
        icon={<Boxes size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:apps.installedDescription")}
      />

      {error && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{error}</MessageBox>}
      {!apps && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}

      {apps?.map((app) => (
        <div key={app.id}>
          <AppCard app={app} onRefresh={load} />
          {app.id === "games" && app.configured && <GuestLinks />}
        </div>
      ))}
    </>
  );
}

// How one container stands. Today's only container is the games, and these are
// still the games' words.
function AppCard({ app, onRefresh }: { app: AppStatus; onRefresh: () => Promise<void> }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const appName = useAppName();
  const dash = "—";
  const state = !app.configured ? "off" : !app.server?.ok ? "unreachable" : app.secretAccepted === false ? "refused" : "on";

  return (
    <section className="config-block" id={`app-${app.id}`}>
      <h2>{appName(app.id)}</h2>
      <p className="muted">{t("controlAdmin:games.intro")}</p>

      {state === "on" && (
        <MessageBox tone="success" title={t("controlAdmin:games.onTitle")}>
          {t("controlAdmin:games.onBody", { version: app.server?.version ?? dash })}
        </MessageBox>
      )}
      {state === "unreachable" && (
        <MessageBox tone="warning" title={t("controlAdmin:games.unreachableTitle")}>
          {t("controlAdmin:games.unreachableBody", { url: app.url ?? dash, error: app.server?.error ?? dash })}
        </MessageBox>
      )}
      {state === "refused" && (
        <MessageBox tone="error" title={t("controlAdmin:games.refusedTitle")}>
          {t("controlAdmin:games.refusedBody")}
        </MessageBox>
      )}
      {state === "off" && (
        <MessageBox tone="info" title={t("controlAdmin:games.offTitle")}>
          {app.reason ?? t("controlAdmin:games.offBody")}
        </MessageBox>
      )}

      <dl className="games-status" aria-label={t("controlAdmin:games.statusLabel")}>
        <div>
          <dt>{t("controlAdmin:games.gateway")}</dt>
          <dd>{app.configured ? t("controlAdmin:games.gatewayOn") : t("controlAdmin:games.gatewayOff")}</dd>
        </div>
        <div>
          <dt>{t("controlAdmin:games.url")}</dt>
          <dd>{app.url ? <code>{app.url}</code> : dash}</dd>
        </div>
        <div>
          <dt>{t("controlAdmin:games.secret")}</dt>
          <dd>
            {!app.secretSet
              ? t("controlAdmin:games.secretUnset")
              : app.secretAccepted === true
                ? t("controlAdmin:games.secretAccepted")
                : app.secretAccepted === false
                  ? t("controlAdmin:games.secretRefused")
                  : t("controlAdmin:games.secretSet")}
          </dd>
        </div>
        <div>
          <dt>{t("controlAdmin:games.server")}</dt>
          <dd>
            {!app.server
              ? t("controlAdmin:games.serverNotAsked")
              : app.server.ok
                ? t("controlAdmin:games.serverVersion", { version: app.server.version ?? dash })
                : app.server.error ?? t("controlAdmin:games.serverDown")}
          </dd>
        </div>
      </dl>

      <p className="muted">
        <Trans
          i18nKey="games.howToSet"
          ns="controlAdmin"
          components={{ url: <code />, secret: <code />, lnk: <a href={CONFIG_DOC} target="_blank" rel="noreferrer" /> }}
        />
      </p>

      <div className="mail-actions">
        <RefreshButton onRefresh={onRefresh} label={t("controlAdmin:games.checkAgain")} compact={false} />
      </div>
    </section>
  );
}

// Every outstanding guest link (docs/games-platform-plan.md → Guests): who
// invited whom to what, whether it was opened and from where, and the one
// thing an admin may do about it — revoke. The links themselves are never
// shown here; the server keeps only their hashes.
function GuestLinks() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [invites, setInvites] = useState<GuestInvite[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<GuestInvite | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [modalError, setModalError] = useState("");

  const load = useCallback(
    () =>
      api<{ invites: GuestInvite[] }>("/api/games/guest-invites?all=1")
        .then((payload) => { setInvites(payload.invites); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.guestLoadFailed")); throw err; }),
    [t]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const revoke = async () => {
    if (!pending) return;
    setRevoking(true);
    setModalError("");
    try {
      await api(`/api/games/guest-invites/${encodeURIComponent(pending.id)}`, { method: "DELETE" });
      setPending(null);
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:games.guestRevokeFailed"));
    } finally {
      setRevoking(false);
    }
  };

  const stateLabel = (invite: GuestInvite) =>
    invite.state === "live" ? t("controlAdmin:games.guestStateLive")
      : invite.state === "revoked" ? t("controlAdmin:games.guestStateRevoked")
        : invite.state === "expired" ? t("controlAdmin:games.guestStateExpired")
          : t("controlAdmin:games.guestStatePending");

  return (
    <section className="config-block" id="games-guest-links">
      <h3>{t("controlAdmin:games.guestTitle")}</h3>
      <p className="muted">{t("controlAdmin:games.guestIntro")}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:games.guestLoadFailed")}>{error}</MessageBox>}

      {invites && (
        <>
          <div className="games-events-tools">
            <RefreshButton onRefresh={load} label={t("controlAdmin:games.refresh")} compact={false} />
          </div>
          {invites.length === 0 ? (
            <p className="muted">{t("controlAdmin:games.guestEmpty")}</p>
          ) : (
            <div className="datagrid-wrap games-events-wrap">
              <table className="datagrid games-events-table games-guests-table">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:games.guestColGuest")}</th>
                    <th>{t("controlAdmin:games.guestColGame")}</th>
                    <th>{t("controlAdmin:games.guestColInvitedBy")}</th>
                    <th>{t("controlAdmin:games.guestColState")}</th>
                    <th>{t("controlAdmin:games.guestColOpened")}</th>
                    <th className="col-actions" aria-label={t("controlAdmin:games.guestColActions")} />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <tr key={invite.id} className={invite.state === "live" ? undefined : "is-muted"}>
                      <td>{invite.guestName}</td>
                      <td><code>{invite.game}</code></td>
                      <td>{invite.createdBy.name}</td>
                      <td>
                        {stateLabel(invite)}
                        {invite.state === "live" && <span className="datagrid-muted"> · {t("controlAdmin:games.guestUntil", { date: formatManagedDate(invite.expiresAt) })}</span>}
                      </td>
                      <td className="datagrid-muted" title={invite.lastIp ?? undefined}>
                        {invite.openedCount === 0
                          ? t("controlAdmin:games.guestNotOpened")
                          : t("controlAdmin:games.guestOpened", { count: invite.openedCount, date: invite.lastSeenAt ? formatManagedDate(invite.lastSeenAt) : "" })}
                        {invite.lastIp && <span className="games-ip">{invite.lastIp}</span>}
                      </td>
                      <td className="col-actions">
                        {invite.state === "live" && (
                          <Button variant="danger" compact onClick={() => { setModalError(""); setPending(invite); }}>
                            <Link2Off size={14} aria-hidden="true" /> {t("controlAdmin:games.guestRevoke")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {pending && (
        <ConfirmDialog
          title={t("controlAdmin:games.guestRevokeTitle", { name: pending.guestName })}
          confirmLabel={t("controlAdmin:games.guestRevoke")}
          busyLabel={t("controlAdmin:games.guestRevoking")}
          danger
          busy={revoking}
          error={modalError}
          onConfirm={() => void revoke()}
          onCancel={() => setPending(null)}
        >
          {t("controlAdmin:games.guestRevokeBody", { name: pending.guestName, by: pending.createdBy.name })}
        </ConfirmDialog>
      )}
    </section>
  );
}

// ── Access ──────────────────────────────────────────────────────────────────

type AppRuleValue = "anywhere" | "trusted" | "home";

/** GET /api/apps/admin/access/:id (modules/apps/access.ts). */
interface AppAccess {
  app: string;
  /** null = nobody but the grants. */
  everyone: "member" | "manager" | null;
  grants: { subjectType: "user" | "group"; subjectId: string; role: "member" | "manager" | "deny"; name: string; email: string | null; missing: boolean }[];
  capabilities: { id: string; rule: AppRuleValue; defaultRule: AppRuleValue }[];
}

/** What one capability is, in the words of the page. One pair per capability this
 *  release's registry declares (modules/apps/registry.ts). */
function useCapabilityWords() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  return (app: string, capability: string): { name: string; means: string } => {
    if (app === "games" && capability === "play") return { name: t("controlAdmin:apps.access.capGamesPlay"), means: t("controlAdmin:apps.access.capGamesPlayMeans") };
    if (app === "games" && capability === "manage") return { name: t("controlAdmin:apps.access.capGamesManage"), means: t("controlAdmin:apps.access.capGamesManageMeans") };
    return { name: capability, means: "" };
  };
}

// Who may use each container and from where (docs/apps-platform-plan.md →
// Access, Network rules). The member box is the one every access list wears
// (shared/AccessControl); the rules are one select per capability.
export function AppsAccessSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const appName = useAppName();
  const words = useCapabilityWords();
  const { apps, error: appsError } = useAppsStatus();
  const [chosen, setChosen] = useState<string | null>(() => queryParam("app"));
  const current = apps?.find((app) => app.id === chosen) ?? apps?.[0] ?? null;
  const [access, setAccess] = useState<AppAccess | null>(null);
  const [people, setPeople] = useState<{ users: AccessCandidate[]; groups: AccessCandidate[] } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setAccess(null);
    api<AppAccess>(`/api/apps/admin/access/${encodeURIComponent(current.id)}`)
      .then((payload) => { if (live) { setAccess(payload); setError(""); } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("controlAdmin:apps.access.loadFailed")); });
    return () => { live = false; };
  }, [current, t]);

  useEffect(() => {
    Promise.all([
      api<{ users: { id: string; displayName: string; email: string }[] }>("/api/users"),
      api<{ groups: { id: string; name: string }[] }>("/api/groups")
    ])
      .then(([users, groups]) => setPeople({
        users: users.users.map((user) => ({ id: user.id, name: `${user.displayName} (${user.email})` })),
        groups: groups.groups.map((group) => ({ id: group.id, name: group.name }))
      }))
      .catch(() => setPeople({ users: [], groups: [] }));
  }, []);

  const choose = (id: string) => {
    setChosen(id);
    replaceQuery("app", id);
  };

  /** One change, and the page redrawn from what the server answers. */
  const change = async (path: string, init: RequestInit) => {
    if (!current) return;
    setSaving(true);
    setError("");
    try {
      setAccess(await api<AppAccess>(`/api/apps/admin/access/${encodeURIComponent(current.id)}${path}`, init));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.access.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const role = (value: string): AccessRole =>
    value === ACCESS_NONE
      ? { value, label: t("controlAdmin:apps.access.roleNone"), tagline: t("controlAdmin:apps.access.roleNoneTagline"), dot: ACCESS_ROLE_DOT.none }
      : value === "manager"
        ? { value, label: t("controlAdmin:apps.access.roleManager"), tagline: t("controlAdmin:apps.access.roleManagerTagline"), dot: ACCESS_ROLE_DOT.manager }
        : value === "deny"
          ? { value, label: t("controlAdmin:apps.access.roleDeny"), tagline: t("controlAdmin:apps.access.roleDenyTagline"), dot: ACCESS_ROLE_DOT.deny }
          : { value, label: t("controlAdmin:apps.access.roleMember"), tagline: t("controlAdmin:apps.access.roleMemberTagline"), dot: ACCESS_ROLE_DOT.member };

  const ruleOptions: { value: AppRuleValue; label: string }[] = [
    { value: "anywhere", label: t("controlAdmin:apps.access.ruleAnywhere") },
    { value: "trusted", label: t("controlAdmin:apps.access.ruleTrusted") },
    { value: "home", label: t("controlAdmin:apps.access.ruleHome") }
  ];

  return (
    <>
      <ControlSectionHead
        section="appsAccess"
        icon={<ShieldCheck size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:apps.access.description")}
      />
      {appsError && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{appsError}</MessageBox>}
      {!apps && !appsError && <p className="muted">{t("controlAdmin:ui.loading")}</p>}

      {apps && current && apps.length > 1 && (
        <div className="games-events-tools">
          <SelectField
            label={t("controlAdmin:apps.appLabel")}
            value={current.id}
            options={apps.map((app) => ({ value: app.id, label: appName(app.id) }))}
            onChange={choose}
            compact
          />
        </div>
      )}

      {error && <MessageBox tone="error" title={t("controlAdmin:apps.access.saveFailed")}>{error}</MessageBox>}

      {current && access && (
        <>
          <section className="config-block" id="app-access-who">
            <h2>{t("controlAdmin:apps.access.whoTitle", { app: appName(current.id) })}</h2>
            <p className="muted">{t("controlAdmin:apps.access.whoIntro")}</p>
            <AccessControl
              roles={["member", "manager", "deny"].map(role)}
              defaultRole="member"
              members={access.grants.map((grant) => ({
                subjectType: grant.subjectType,
                subjectId: grant.subjectId,
                role: grant.role,
                name: grant.name,
                sub: grant.subjectType === "user" ? grant.email ?? undefined : undefined,
                missing: grant.missing
              }))}
              candidates={people ?? undefined}
              everyone={{
                role: access.everyone,
                hint: t("controlAdmin:apps.access.everyoneHint"),
                options: [ACCESS_NONE, "member", "manager"].map(role),
                onChange: (value) => void change("/everyone", { method: "PUT", body: JSON.stringify({ role: value }) }),
                lockedHint: t("controlAdmin:apps.access.everyoneLocked"),
                publicTag: false
              }}
              busy={saving}
              emptyHint={t("controlAdmin:apps.access.noGrants")}
              onGrant={(subjectType, subjectId, value) => void change("/grants", { method: "POST", body: JSON.stringify({ subjectType, subjectId, role: value }) })}
              onRevoke={(subjectType, subjectId) => void change(`/grants/${subjectType}/${encodeURIComponent(subjectId)}`, { method: "DELETE" })}
            />
          </section>

          <section className="config-block" id="app-access-where">
            <h2>{t("controlAdmin:apps.access.whereTitle")}</h2>
            <p className="muted">{t("controlAdmin:apps.access.whereIntro")}</p>
            <div className="datagrid-wrap">
              <table className="datagrid app-rules-table">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:apps.access.colWhat")}</th>
                    <th>{t("controlAdmin:apps.access.colRule")}</th>
                  </tr>
                </thead>
                <tbody>
                  {access.capabilities.map((capability) => {
                    const said = words(current.id, capability.id);
                    return (
                      <tr key={capability.id}>
                        <td>
                          <strong>{said.name}</strong>
                          {said.means && <span className="datagrid-muted app-rule-means">{said.means}</span>}
                        </td>
                        <td>
                          <SelectField
                            label={t("controlAdmin:apps.access.ruleFor", { what: said.name })}
                            value={capability.rule}
                            options={ruleOptions}
                            onChange={(rule) => void change("/rules", { method: "PUT", body: JSON.stringify({ [capability.id]: rule }) })}
                            disabled={saving}
                            compact
                            hideLabel
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">{t("controlAdmin:apps.access.ruleHint")}</p>
          </section>
        </>
      )}
    </>
  );
}

// ── Setup: pairing ──────────────────────────────────────────────────────────

// Pairing a container with this server (docs/apps-platform-plan.md → Pairing):
// where it is (the environment), the secret both sides sign with (made here,
// shown once), what to set on the container, and a test. A secret in this
// container's environment wins, and pairing here stays off while it is set.
export function AppsSetupSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const appName = useAppName();
  const { apps, error: appsError, load } = useAppsStatus();
  const [chosen, setChosen] = useState<string | null>(() => queryParam("app"));
  const current = apps?.find((app) => app.id === chosen) ?? apps?.[0] ?? null;
  const [fresh, setFresh] = useState<{ app: string; secret: string } | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "forget" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const [copied, setCopied] = useState(false);

  const choose = (id: string) => {
    setChosen(id);
    setFresh(null);
    setTested(false);
    replaceQuery("app", id);
  };

  const generate = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const made = await api<{ secret: string }>(`/api/apps/admin/pairing/${encodeURIComponent(current.id)}`, { method: "POST" });
      setFresh({ app: current.id, secret: made.secret });
      setConfirm(null);
      setTested(false);
      await load().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.pairFailed"));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/apps/admin/pairing/${encodeURIComponent(current.id)}`, { method: "DELETE" });
      setFresh(null);
      setConfirm(null);
      await load().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.forgetFailed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard (an insecure LAN origin): the secret can still be selected */
    }
  };

  const test = async () => {
    await load();
    setTested(true);
  };

  const dash = "—";
  const shown = fresh && current && fresh.app === current.id ? fresh.secret : null;

  return (
    <>
      <ControlSectionHead
        section="appsSetup"
        icon={<KeyRound size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:apps.setup.description")}
      />
      {appsError && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{appsError}</MessageBox>}
      {!apps && !appsError && <p className="muted">{t("controlAdmin:ui.loading")}</p>}

      {apps && current && apps.length > 1 && (
        <div className="games-events-tools">
          <SelectField
            label={t("controlAdmin:apps.appLabel")}
            value={current.id}
            options={apps.map((app) => ({ value: app.id, label: appName(app.id) }))}
            onChange={choose}
            compact
          />
        </div>
      )}

      {error && <MessageBox tone="error" title={t("controlAdmin:apps.setup.pairFailed")}>{error}</MessageBox>}

      {current && (
        <>
          <section className="config-block" id="app-setup-address">
            <h2>{t("controlAdmin:apps.setup.addressTitle")}</h2>
            <p className="muted">
              <Trans i18nKey="apps.setup.addressIntro" ns="controlAdmin" values={{ variable: current.variables.url }} components={{ code: <code /> }} />
            </p>
            <dl className="games-status">
              <div>
                <dt>{current.variables.url}</dt>
                <dd>{current.url ? <code>{current.url}</code> : t("controlAdmin:apps.setup.addressUnset")}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.server")}</dt>
                <dd>
                  {!current.server
                    ? t("controlAdmin:games.serverNotAsked")
                    : current.server.ok
                      ? t("controlAdmin:games.serverVersion", { version: current.server.version ?? dash })
                      : current.server.error ?? t("controlAdmin:games.serverDown")}
                </dd>
              </div>
            </dl>
          </section>

          <section className="config-block" id="app-setup-secret">
            <h2>{t("controlAdmin:apps.setup.secretTitle")}</h2>
            <p className="muted">{t("controlAdmin:apps.setup.secretIntro")}</p>

            {current.secretSource === "environment" && (
              <MessageBox tone="info" title={t("controlAdmin:apps.setup.fromEnvironmentTitle")}>
                <Trans i18nKey="apps.setup.fromEnvironmentBody" ns="controlAdmin" values={{ variable: current.variables.secret }} components={{ code: <code /> }} />
              </MessageBox>
            )}
            {current.secretSource === "paired" && current.pairing && !shown && (
              <p>{t("controlAdmin:apps.setup.pairedOn", { date: formatManagedDate(current.pairing.pairedAt), name: current.pairing.pairedBy ?? dash })}</p>
            )}
            {current.secretSource === "none" && !shown && <p>{t("controlAdmin:apps.setup.noSecret")}</p>}

            {shown && (
              <div className="app-secret-once">
                <p><strong>{t("controlAdmin:apps.setup.shownOnce")}</strong></p>
                <div className="app-secret-row">
                  <code className="app-secret-value">{shown}</code>
                  <Button variant="secondary" onClick={() => void copy(shown)}>
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {copied ? t("controlAdmin:games.copied") : t("controlAdmin:games.copy")}
                  </Button>
                </div>
              </div>
            )}

            {current.secretSource !== "environment" && (
              <div className="mail-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => (current.secretSource === "paired" ? setConfirm("replace") : void generate())}
                >
                  {busy ? t("controlAdmin:apps.setup.generating") : current.secretSource === "paired" ? t("controlAdmin:apps.setup.replace") : t("controlAdmin:apps.setup.generate")}
                </Button>
                {current.secretSource === "paired" && (
                  <Button variant="danger" disabled={busy} onClick={() => setConfirm("forget")}>{t("controlAdmin:apps.setup.forget")}</Button>
                )}
              </div>
            )}
          </section>

          <section className="config-block" id="app-setup-container">
            <h2>{t("controlAdmin:apps.setup.containerTitle", { app: appName(current.id) })}</h2>
            <p className="muted">{t("controlAdmin:apps.setup.containerIntro")}</p>
            <dl className="games-status">
              <div>
                <dt><code>{current.variables.container}</code></dt>
                <dd>{current.secretSource === "environment" ? t("controlAdmin:apps.setup.containerSameAsEnv", { variable: current.variables.secret }) : t("controlAdmin:apps.setup.containerSecret")}</dd>
              </div>
            </dl>
          </section>

          <section className="config-block" id="app-setup-test">
            <h2>{t("controlAdmin:apps.setup.testTitle")}</h2>
            <div className="mail-actions">
              <RefreshButton onRefresh={test} label={t("controlAdmin:apps.setup.test")} compact={false} />
            </div>
            {tested && (
              current.configured && current.server?.ok && current.secretAccepted === true
                ? <MessageBox tone="success" title={t("controlAdmin:apps.setup.testOkTitle")}>{t("controlAdmin:apps.setup.testOkBody", { app: appName(current.id) })}</MessageBox>
                : current.configured && current.server?.ok && current.secretAccepted === false
                  ? <MessageBox tone="error" title={t("controlAdmin:games.refusedTitle")}>{t("controlAdmin:apps.setup.testRefusedBody", { variable: current.variables.container })}</MessageBox>
                  : <MessageBox tone="warning" title={t("controlAdmin:apps.setup.testFailedTitle")}>{current.reason ?? current.server?.error ?? t("controlAdmin:games.serverDown")}</MessageBox>
            )}
          </section>
        </>
      )}

      {current && confirm === "replace" && (
        <ConfirmDialog
          title={t("controlAdmin:apps.setup.replaceTitle", { app: appName(current.id) })}
          confirmLabel={t("controlAdmin:apps.setup.replace")}
          busyLabel={t("controlAdmin:apps.setup.generating")}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void generate()}
          onCancel={() => setConfirm(null)}
        >
          {t("controlAdmin:apps.setup.replaceBody", { app: appName(current.id), variable: current.variables.container })}
        </ConfirmDialog>
      )}
      {current && confirm === "forget" && (
        <ConfirmDialog
          title={t("controlAdmin:apps.setup.forgetTitle", { app: appName(current.id) })}
          confirmLabel={t("controlAdmin:apps.setup.forget")}
          busyLabel={t("controlAdmin:apps.setup.forgetting")}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void forget()}
          onCancel={() => setConfirm(null)}
        >
          {t("controlAdmin:apps.setup.forgetBody", { app: appName(current.id) })}
        </ConfirmDialog>
      )}
    </>
  );
}

// ── Events and Logs: one container at a time ────────────────────────────────

/** The running containers and the one being looked at, seeded from `?app=` so a
 *  link can open the page on a container and a reload keeps it. */
function useChosenApp() {
  const { apps, error } = useAppsStatus();
  const [chosen, setChosen] = useState<string | null>(() => queryParam("app"));
  const running = apps?.filter(isRunning) ?? [];
  const current = running.find((app) => app.id === chosen) ?? running[0] ?? null;
  const choose = (id: string) => {
    setChosen(id);
    replaceQuery("app", id);
  };
  return { apps, error, running, current, choose };
}

function AppPicker({ running, current, onChoose }: { running: AppStatus[]; current: AppStatus; onChoose: (id: string) => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const appName = useAppName();
  // One container needs no choice; the picker appears with the second.
  if (running.length < 2) return null;
  return (
    <div className="games-events-tools">
      <SelectField
        label={t("controlAdmin:apps.appLabel")}
        value={current.id}
        options={running.map((app) => ({ value: app.id, label: appName(app.id) }))}
        onChange={onChoose}
        compact
      />
    </div>
  );
}

/** Events and Logs say so when there is no container to ask, and where to look. */
function NoneRunning() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const href = controlHref("appsInstalled");
  return (
    <MessageBox tone="info" title={t("controlAdmin:apps.noneRunningTitle")}>
      <Trans
        i18nKey="apps.noneRunningBody"
        ns="controlAdmin"
        components={{ lnk: <a href={href} onClick={(event) => followRoute(event, href)} /> }}
      />
    </MessageBox>
  );
}

export function AppsEventsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const { apps, error, running, current, choose } = useChosenApp();

  return (
    <>
      <ControlSectionHead
        section="appsEvents"
        icon={<Siren size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:apps.eventsDescription")}
      />
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{error}</MessageBox>}
      {!apps && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}
      {apps && !current && <NoneRunning />}
      {current && (
        <>
          <AppPicker running={running} current={current} onChoose={choose} />
          <AppEvents key={current.id} prefix={current.prefix} />
        </>
      )}
    </>
  );
}

export function AppsLogsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const { apps, error, running, current, choose } = useChosenApp();

  return (
    <>
      <ControlSectionHead
        section="appsLogs"
        icon={<ScrollText size={30} />}
        iconClassName="logs"
        description={t("controlAdmin:apps.logsDescription")}
      />
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.loadFailed")}>{error}</MessageBox>}
      {!apps && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}
      {apps && !current && <NoneRunning />}
      {current && (
        <>
          <AppPicker running={running} current={current} onChoose={choose} />
          <AppLog key={current.id} prefix={current.prefix} />
        </>
      )}
    </>
  );
}

// What a container recorded: refused callers, invitations, finished matches,
// moves thrown out, errors. Asked of the container through the gateway, which
// forwards this admin's role; nothing is kept here.
function AppEvents({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EventsPage | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (level !== "all") params.set("level", level);
    return api<EventsPage>(`${prefix}/api/admin/events?${params}`)
      .then((payload) => { setData(payload); setError(""); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.eventsLoadFailed")); throw err; });
  }, [level, page, prefix, t]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const levelOptions: { value: LevelFilter; label: string }[] = [
    { value: "all", label: t("controlAdmin:games.levelAll") },
    { value: "info", label: t("controlAdmin:games.levelInfo") },
    { value: "warn", label: t("controlAdmin:games.levelWarn") },
    { value: "error", label: t("controlAdmin:games.levelError") }
  ];

  return (
    <section className="config-block" id="app-events">
      <p className="muted">{t("controlAdmin:games.eventsIntro", { days: data?.retentionDays ?? 90 })}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:games.eventsLoadFailed")}>{error}</MessageBox>}

      {data && (
        <>
          <p className={data.rejected24h > 0 ? "games-rejected is-warning" : "games-rejected"}>
            {t("controlAdmin:games.rejected24h", { count: data.rejected24h })}
          </p>

          <div className="games-events-tools">
            <SelectField
              label={t("controlAdmin:games.levelLabel")}
              value={level}
              options={levelOptions}
              onChange={(value) => { setLevel(value); setPage(1); }}
              compact
              hideLabel
            />
            <RefreshButton onRefresh={load} label={t("controlAdmin:games.refresh")} compact={false} />
          </div>

          {data.events.length === 0 ? (
            <p className="muted">{t("controlAdmin:games.eventsEmpty")}</p>
          ) : (
            <div className="datagrid-wrap games-events-wrap">
              <table className="datagrid games-events-table">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:games.colTime")}</th>
                    <th>{t("controlAdmin:games.colLevel")}</th>
                    <th>{t("controlAdmin:games.colEvent")}</th>
                    <th>{t("controlAdmin:games.colWho")}</th>
                    <th>{t("controlAdmin:games.colDetail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((entry) => (
                    <tr key={entry.id} className={entry.level === "info" ? undefined : `is-${entry.level}`}>
                      <td className="datagrid-muted">{formatManagedDate(entry.at)}</td>
                      <td><span className={`games-level games-level-${entry.level}`}>{t(`controlAdmin:games.level${entry.level === "info" ? "Info" : entry.level === "warn" ? "Warn" : "Error"}`)}</span></td>
                      <td><code>{entry.event}</code></td>
                      <td className="datagrid-muted" title={[entry.actorId, entry.ip, entry.requestId].filter(Boolean).join(" · ")}>
                        {entry.actorName ?? entry.actorId ?? t("controlAdmin:games.whoNobody")}
                        {entry.ip && <span className="games-ip">{entry.ip}</span>}
                      </td>
                      <td className="games-detail">{entry.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Pager page={data.page} totalPages={data.totalPages} onChange={setPage} />
        </>
      )}
    </section>
  );
}

// The newest lines of a container's log, from the ring buffer its server keeps
// — what `docker logs` would show, without a shell on the host.
function AppLog({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [tail, setTail] = useState<LogTail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    () =>
      api<LogTail>(`${prefix}/api/admin/log?lines=${LOG_LINES}`)
        .then((payload) => { setTail(payload); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.logLoadFailed")); throw err; }),
    [prefix, t]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const text = tail ? tail.lines.map(formatLogLine).join("\n") : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tail?.lines.join("\n") ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no clipboard (an insecure LAN origin): the text can still be selected */
    }
  };

  return (
    <section className="config-block" id="app-log">
      <p className="muted">{t("controlAdmin:games.logIntro", { count: LOG_LINES })}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:games.logLoadFailed")}>{error}</MessageBox>}

      {tail && !tail.available && (
        <MessageBox tone="info" title={t("controlAdmin:games.logUnavailableTitle")}>{t("controlAdmin:games.logUnavailableBody")}</MessageBox>
      )}

      {tail && tail.available && (
        <>
          <div className="games-events-tools">
            <RefreshButton onRefresh={load} label={t("controlAdmin:games.refresh")} compact={false} />
            <Button variant="secondary" onClick={copy} disabled={tail.lines.length === 0}>
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? t("controlAdmin:games.copied") : t("controlAdmin:games.copy")}
            </Button>
          </div>
          {tail.lines.length === 0
            ? <p className="muted">{t("controlAdmin:games.logEmpty")}</p>
            : <pre className="games-log" tabIndex={0} aria-label={t("controlAdmin:games.logTitle")}>{text}</pre>}
        </>
      )}
    </section>
  );
}
