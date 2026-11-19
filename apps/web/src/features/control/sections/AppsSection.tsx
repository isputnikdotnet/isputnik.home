import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2Off, ShieldCheck } from "lucide-react";
import { api } from "../../../api";
import { queryParam, replaceQuery } from "../../../router";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl, type AccessRole } from "../../../shared/AccessControl";
import { AccessDialog } from "../../../shared/AccessDialog";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { CommandRow, GroupedList, PickerRow } from "../../../shared/GroupedList";
import { useQueryPage } from "../../../shared/useQueryPage";
import { MessageBox } from "../../../shared/MessageBox";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectField } from "../../../shared/SelectField";
import { formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";

// The containers beside this server (docs/apps-platform-plan.md), as the control
// panel's pages show them since the Apps group was folded into the rest
// (docs/dashboard-and-backups-plan.md). Here: Security › App access and
// Settings › Apps (pairing: the address and the secret, each saved here unless
// this container's environment sets it, which wins; the secret is shown once),
// and the pieces other pages host — a container's events and server log
// (Overview › Logs), the games' guest links (Members › Invites) and the video
// engine's settings (Settings › Video). Everything about a container is read
// from it through the gateway with this admin's own session; nothing is kept here.

/** One container, as GET /api/apps/admin/status answers for it. */
export interface AppStatus {
  id: string;
  kind: "app" | "engine";
  /** Keeps no data: no backup card, nothing in a backup. */
  stateless: boolean;
  /** Where it answers on this origin: its admin events and log are under it. */
  prefix: string;
  configured: boolean;
  reason: string | null;
  url: string | null;
  /** Where the address came from: this container's environment wins over Setup. */
  urlSource: "environment" | "saved" | "none";
  /** The usual address on a shared Docker network, offered on Setup. */
  exampleUrl: string;
  secretSet: boolean;
  /** Where the secret in force came from (modules/apps/pairing.ts). */
  secretSource: "environment" | "paired" | "none";
  pairing: { pairedAt: string; pairedBy: string | null } | null;
  /** The variable names Setup quotes: this container's two, and the container's own. */
  variables: { url: string; secret: string; container: string };
  /** Whether the container takes this app's signature; null = not asked or unknown. */
  secretAccepted: boolean | null;
  server: { ok: boolean; version: string | null; error: string | null; roundTripMs: number | null } | null;
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

/** Up, set up and taking our signature: the containers Logs can ask. */
export function isRunning(app: AppStatus): boolean {
  return app.configured && Boolean(app.server?.ok) && app.secretAccepted !== false;
}

/** Every container this release knows, with how it stands. */
export function useAppsStatus() {
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

export function useAppName() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  // One name per container this release knows; the registry (modules/apps) has the same list.
  return (id: string) => (id === "games" ? t("common:nav.games") : id === "video" ? t("common:nav.video") : id === "faces" ? t("common:nav.faces") : id);
}

// Every outstanding guest link (docs/games-platform-plan.md → Guests): who
// invited whom to what, whether it was opened and from where, and the one
// thing an admin may do about it — revoke. The links themselves are never
// shown here; the server keeps only their hashes.
export function GuestLinks() {
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
      <h2>{t("controlAdmin:games.guestTitle")}</h2>
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

/** Someone who could be given access: a member (with their address) or a group. */
interface Candidate { id: string; name: string; sub?: string }

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
    if (app === "video" && capability === "browse") return { name: t("controlAdmin:apps.access.capVideoBrowse"), means: t("controlAdmin:apps.access.capVideoBrowseMeans") };
    if (app === "video" && capability === "watch") return { name: t("controlAdmin:apps.access.capVideoWatch"), means: t("controlAdmin:apps.access.capVideoWatchMeans") };
    if (app === "video" && capability === "manage") return { name: t("controlAdmin:apps.access.capVideoManage"), means: t("controlAdmin:apps.access.capVideoManageMeans") };
    return { name: capability, means: "" };
  };
}

// Who may use each container and from where (docs/apps-platform-plan.md →
// Access, Network rules), as grouped rows (control panel v2): which application,
// then who may use it — ONE row saying it, whose Change opens the standard access
// window (shared/AccessDialog, owner 2026-11-16) — then one rule per capability for
// where it is allowed from. Every change is saved at once and the page redrawn from
// what the server answers.
export function AppsAccessSection() {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const appName = useAppName();
  const words = useCapabilityWords();
  const { apps, error: appsError } = useAppsStatus();
  const [chosen, setChosen] = useState<string | null>(() => queryParam("app"));
  const current = apps?.find((app) => app.id === chosen) ?? apps?.[0] ?? null;
  const [access, setAccess] = useState<AppAccess | null>(null);
  const [people, setPeople] = useState<{ users: Candidate[]; groups: Candidate[] } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // The access window, open; ?show=add (the old add page's address) opens it too.
  const [show, go] = useQueryPage();
  const [accessOpen, setAccessOpen] = useState(show === "add");

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
        users: users.users.map((user) => ({ id: user.id, name: user.displayName, sub: user.email })),
        groups: groups.groups.map((group) => ({ id: group.id, name: group.name }))
      }))
      .catch(() => setPeople({ users: [], groups: [] }));
  }, []);

  const choose = (id: string) => {
    setChosen(id);
    replaceQuery("app", id);
  };

  /** One change, and the page redrawn from what the server answers. */
  const change = async (path: string, init: RequestInit): Promise<boolean> => {
    if (!current) return false;
    setSaving(true);
    setError("");
    try {
      setAccess(await api<AppAccess>(`/api/apps/admin/access/${encodeURIComponent(current.id)}${path}`, init));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:apps.access.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const roleLabel = (value: string): string =>
    value === ACCESS_NONE
      ? t("controlAdmin:apps.access.roleNone")
      : value === "manager"
        ? t("controlAdmin:apps.access.roleManager")
        : value === "deny"
          ? t("controlAdmin:apps.access.roleDeny")
          : t("controlAdmin:apps.access.roleMember");

  const ruleOptions: { value: AppRuleValue; label: string }[] = [
    { value: "anywhere", label: t("controlAdmin:apps.access.ruleAnywhere") },
    { value: "trusted", label: t("controlAdmin:apps.access.ruleTrusted") },
    { value: "home", label: t("controlAdmin:apps.access.ruleHome") }
  ];

  // The access window's vocabulary: what a grant may be, and the baseline's.
  const roleDot: Record<string, string> = { member: ACCESS_ROLE_DOT.member, manager: ACCESS_ROLE_DOT.manager, deny: ACCESS_ROLE_DOT.deny, [ACCESS_NONE]: ACCESS_ROLE_DOT.none };
  const accessRole = (value: string): AccessRole => ({
    value,
    label: roleLabel(value),
    tagline: value === "manager" ? t("controlAdmin:apps.access.roleManagerMeans") : value === "deny" ? t("controlAdmin:apps.access.roleDenyMeans") : value === ACCESS_NONE ? "" : t("controlAdmin:apps.access.roleMemberMeans"),
    dot: roleDot[value]
  });
  /** Who has it, in a line: the baseline, then the grants by role. */
  const accessSummary = (payload: AppAccess): string => {
    const parts: string[] = [];
    if (payload.everyone) parts.push(`${t("common:access.everyone")} (${roleLabel(payload.everyone)})`);
    const allowed = payload.grants.filter((grant) => grant.role !== "deny");
    if (allowed.length) parts.push(allowed.slice(0, 3).map((grant) => `${grant.name} (${roleLabel(grant.role)})`).join(", ") + (allowed.length > 3 ? " …" : ""));
    const blocked = payload.grants.length - allowed.length;
    if (blocked) parts.push(t("controlAdmin:apps.access.blockedCount", { count: blocked }));
    return parts.join(" · ") || t("controlAdmin:apps.access.noGrants");
  };
  const closeAccess = () => { setAccessOpen(false); if (show === "add") go(null); };

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

      {apps && current && (
        <div className="grouped-page">
          {error && <MessageBox tone="error" title={t("controlAdmin:apps.access.saveFailed")}>{error}</MessageBox>}

          <>
              {apps.length > 1 && (
                <GroupedList>
                  <PickerRow
                    label={t("controlAdmin:apps.appLabel")}
                    value={current.id}
                    options={apps.map((app) => ({ value: app.id, label: appName(app.id) }))}
                    onChange={choose}
                  />
                </GroupedList>
              )}

              {access && (
                <>
                  {/* Who may use it: one row, the standard access window behind Change. */}
                  <GroupedList id="app-access-who" title={t("controlAdmin:apps.access.whoTitle", { app: appName(current.id) })} note={t("controlAdmin:apps.access.whoIntro")}>
                    <CommandRow
                      icon={<ShieldCheck size={17} />}
                      label={t("common:access.title")}
                      sub={accessSummary(access)}
                      value={t("controlAdmin:personalLibraries.change")}
                      disabled={saving}
                      onClick={() => setAccessOpen(true)}
                    />
                  </GroupedList>

                  {accessOpen && (
                    <AccessDialog
                      title={t("controlAdmin:apps.access.whoTitle", { app: appName(current.id) })}
                      intro={t("controlAdmin:apps.access.whoIntro")}
                      error={error}
                      errorTitle={t("controlAdmin:apps.access.saveFailed")}
                      busy={saving}
                      onClose={closeAccess}
                    >
                      <AccessControl
                        roles={["member", "manager", "deny"].map(accessRole)}
                        defaultRole="member"
                        members={access.grants.map((grant) => ({
                          subjectType: grant.subjectType,
                          subjectId: grant.subjectId,
                          name: grant.name,
                          sub: grant.subjectType === "user" ? grant.email ?? undefined : undefined,
                          role: grant.role,
                          missing: grant.missing
                        }))}
                        candidates={people ?? { users: [], groups: [] }}
                        everyone={{
                          role: access.everyone,
                          hint: t("controlAdmin:apps.access.everyoneHint"),
                          options: [ACCESS_NONE, "member", "manager"].map(accessRole),
                          publicTag: false,
                          onChange: (role) => void change("/everyone", { method: "PUT", body: JSON.stringify({ role: role ?? ACCESS_NONE }) })
                        }}
                        busy={saving}
                        onGrant={(subjectType, subjectId, role) => change("/grants", { method: "POST", body: JSON.stringify({ subjectType, subjectId, role }) })}
                        onRevoke={(subjectType, subjectId) => change(`/grants/${subjectType}/${encodeURIComponent(subjectId)}`, { method: "DELETE" })}
                      />
                    </AccessDialog>
                  )}

                  <GroupedList
                    id="app-access-where"
                    title={t("controlAdmin:apps.access.whereTitle")}
                    note={<>{t("controlAdmin:apps.access.whereIntro")} {t("controlAdmin:apps.access.ruleHint")}</>}
                  >
                    {access.capabilities.map((capability) => {
                      const said = words(current.id, capability.id);
                      return (
                        <PickerRow
                          key={capability.id}
                          label={said.name}
                          sub={said.means || undefined}
                          ariaLabel={t("controlAdmin:apps.access.ruleFor", { what: said.name })}
                          value={capability.rule}
                          options={ruleOptions}
                          disabled={saving}
                          onChange={(rule) => void change("/rules", { method: "PUT", body: JSON.stringify({ [capability.id]: rule }) })}
                        />
                      );
                    })}
                  </GroupedList>
                </>
              )}
          </>
        </div>
      )}
    </>
  );
}

// ── Setup: pairing ──────────────────────────────────────────────────────────

// Pairing a container with this server (docs/apps-platform-plan.md → Pairing):
// where it is (saved here), the secret both sides sign with (made here, shown
// once), what to set on the container, and a test. An address or a secret in
// this container's environment wins, and that half of Setup stays off while it is set.
// Infrastructure › Services › Pairing as grouped rows (control panel v2): which
// container, where it is and whether it answers, the shared secret, what to set on
// the container, and a test.
// What a container recorded: refused callers, invitations, finished matches,
// moves thrown out, errors. Asked of the container through the gateway, which
// forwards this admin's role; nothing is kept here.
/** A container's recorded events. `app` and `name` say whose: Games' line names
 *  what it records (matches, moves); any other container's says it in general. */
export function AppEvents({ prefix, app, name }: { prefix: string; app: string; name: string }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  // The Dashboard links here with ?level=error for a container that logged errors.
  const [level, setLevel] = useState<LevelFilter>(() => {
    const wanted = queryParam("level");
    return wanted === "info" || wanted === "warn" || wanted === "error" ? wanted : "all";
  });
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
      <p className="muted">
        {app === "games"
          ? t("controlAdmin:games.eventsIntro", { days: data?.retentionDays ?? 90 })
          : t("controlAdmin:games.eventsIntroOther", { app: name, days: data?.retentionDays ?? 90 })}
      </p>

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
export function AppLog({ prefix }: { prefix: string }) {
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
