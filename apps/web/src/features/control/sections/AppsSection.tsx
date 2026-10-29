import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, KeyRound, Link2Off, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { queryParam, replaceQuery } from "../../../router";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl, type AccessCandidate, type AccessRole } from "../../../shared/AccessControl";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectField } from "../../../shared/SelectField";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
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
  return (id: string) => (id === "games" ? t("common:nav.games") : id === "video" ? t("common:nav.video") : id);
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

/** GET/PUT /video/api/admin/conversion: the engine's limits on converting video
 *  while someone watches, and who is converting now (isputnik.video hls.ts). */
interface ConversionSettings {
  memoryPerViewerMb: number;
  maxViewers: number;
  whenFull: "disk" | "wait";
}

interface ConversionState {
  available: boolean;
  settings: ConversionSettings;
  usage: {
    viewers: { user: string; title: string; mode: string; converting: boolean; memoryBytes: number; diskBytes: number }[];
    memoryBytes: number;
    diskBytes: number;
  };
}

// Films a browser can't play as they are get converted as they play. Each
// viewer's segments are kept in the engine's memory up to a share set here, then
// on the disk (or the conversion waits); only so many people convert at once,
// the next is told to try later. Saved in the engine, read through the gateway.
export function VideoConversion({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [state, setState] = useState<ConversionState | null>(null);
  const [form, setForm] = useState<{ memory: string; viewers: string; whenFull: ConversionSettings["whenFull"] } | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const url = `${prefix}/api/admin/conversion`;

  const load = useCallback(
    () =>
      api<ConversionState>(url)
        .then((payload) => { setState(payload); setError(""); return payload; })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:apps.conversion.loadFailed")); throw err; }),
    [t, url]
  );

  useEffect(() => {
    load()
      .then((payload) => setForm({ memory: String(payload.settings.memoryPerViewerMb), viewers: String(payload.settings.maxViewers), whenFull: payload.settings.whenFull }))
      .catch(() => undefined);
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const body: ConversionSettings = { memoryPerViewerMb: Number(form.memory), maxViewers: Number(form.viewers), whenFull: form.whenFull };
      setState(await api<ConversionState>(url, { method: "PUT", body: JSON.stringify(body) }));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:apps.conversion.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const memoryMb = form ? Number(form.memory) : 0;
  const viewers = form ? Number(form.viewers) : 0;
  const usage = state?.usage;

  return (
    <section className="config-block" id="video-conversion">
      <h3>{t("controlAdmin:apps.conversion.title")}</h3>
      <p className="muted">{t("controlAdmin:apps.conversion.intro")}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:apps.conversion.loadFailed")}>{error}</MessageBox>}
      {state && !state.available && (
        <MessageBox tone="warning" title={t("controlAdmin:apps.conversion.noFfmpegTitle")}>{t("controlAdmin:apps.conversion.noFfmpegBody")}</MessageBox>
      )}

      {usage && (
        <>
          <dl className="games-status" aria-label={t("controlAdmin:apps.conversion.nowLabel")}>
            <div>
              <dt>{t("controlAdmin:apps.conversion.watching")}</dt>
              <dd>{t("controlAdmin:apps.conversion.watchingValue", { now: usage.viewers.length, limit: state.settings.maxViewers })}</dd>
            </div>
            <div>
              <dt>{t("controlAdmin:apps.conversion.inMemory")}</dt>
              <dd>{formatBytes(usage.memoryBytes)}</dd>
            </div>
            <div>
              <dt>{t("controlAdmin:apps.conversion.onDisk")}</dt>
              <dd>{formatBytes(usage.diskBytes)}</dd>
            </div>
          </dl>
          {usage.viewers.length > 0 && (
            <div className="datagrid-wrap games-events-wrap">
              <table className="datagrid games-events-table video-conversion-table">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:apps.conversion.colWho")}</th>
                    <th>{t("controlAdmin:apps.conversion.colWhat")}</th>
                    <th>{t("controlAdmin:apps.conversion.colHow")}</th>
                    <th>{t("controlAdmin:apps.conversion.inMemory")}</th>
                    <th>{t("controlAdmin:apps.conversion.onDisk")}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.viewers.map((viewer, index) => (
                    <tr key={`${viewer.user}-${index}`}>
                      <td>{viewer.user}</td>
                      <td>{viewer.title}</td>
                      <td className="datagrid-muted">
                        {viewer.mode === "transcode" ? t("controlAdmin:apps.conversion.modeTranscode") : t("controlAdmin:apps.conversion.modeRemux")}
                        {!viewer.converting && ` · ${t("controlAdmin:apps.conversion.paused")}`}
                      </td>
                      <td>{formatBytes(viewer.memoryBytes)}</td>
                      <td>{formatBytes(viewer.diskBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="games-events-tools">
            <RefreshButton onRefresh={() => load().then(() => undefined)} label={t("controlAdmin:games.refresh")} compact={false} />
          </div>
        </>
      )}

      {form && (
        <form className="security-policy-form" onSubmit={(event) => void save(event)}>
          <label className="security-setting-row">
            <span className="security-setting-copy">
              <span className="security-setting-label">{t("controlAdmin:apps.conversion.viewersLabel")}</span>
              <span className="security-setting-help">{t("controlAdmin:apps.conversion.viewersHelp")}</span>
            </span>
            <input type="number" min={1} max={50} required value={form.viewers} onChange={(event) => setForm({ ...form, viewers: event.target.value })} />
          </label>
          <label className="security-setting-row">
            <span className="security-setting-copy">
              <span className="security-setting-label">{t("controlAdmin:apps.conversion.memoryLabel")}</span>
              <span className="security-setting-help">{t("controlAdmin:apps.conversion.memoryHelp")}</span>
            </span>
            <input type="number" min={0} max={16384} step={50} required value={form.memory} onChange={(event) => setForm({ ...form, memory: event.target.value })} />
          </label>
          <div className="security-setting-row">
            <span className="security-setting-copy">
              <span className="security-setting-label">{t("controlAdmin:apps.conversion.whenFullLabel")}</span>
              <span className="security-setting-help">{t("controlAdmin:apps.conversion.whenFullHelp")}</span>
            </span>
            <SelectField
              label={t("controlAdmin:apps.conversion.whenFullLabel")}
              hideLabel
              value={form.whenFull}
              disabled={memoryMb === 0}
              options={[
                { value: "disk", label: t("controlAdmin:apps.conversion.whenFullDisk") },
                { value: "wait", label: t("controlAdmin:apps.conversion.whenFullWait") }
              ]}
              onChange={(value) => setForm({ ...form, whenFull: value })}
            />
          </div>
          <p className="muted">
            {memoryMb === 0
              ? t("controlAdmin:apps.conversion.totalDiskOnly")
              : t("controlAdmin:apps.conversion.total", { memory: formatBytes(memoryMb * viewers * 1024 * 1024) })}
          </p>
          {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
          {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:apps.conversion.saved")}</MessageBox>}
          <div className="security-policy-actions">
            <Button variant="primary" type="submit" disabled={saving}>
              <Save size={16} aria-hidden="true" />
              {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:apps.conversion.save")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** GET/PUT /video/api/admin/metadata: whether the engine has a TMDB key (never the key). */
interface MetadataState {
  hasKey: boolean;
  keyHint: string | null;
}

// Posters and descriptions: art beside the files is always used; with a key from
// the admin's own TMDB account the engine fetches the rest. The engine checks a
// key with TMDB before keeping it, and never hands it back.
export function VideoMetadata({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [state, setState] = useState<MetadataState | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [saved, setSaved] = useState("");
  const url = `${prefix}/api/admin/metadata`;

  useEffect(() => {
    api<MetadataState>(url)
      .then((payload) => { setState(payload); setError(""); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("controlAdmin:apps.metadata.loadFailed")));
  }, [t, url]);

  const put = async (tmdbKey: string | null) => {
    setBusy(tmdbKey ? "save" : "remove");
    setSaved("");
    setSaveError("");
    try {
      setState(await api<MetadataState>(url, { method: "PUT", body: JSON.stringify({ tmdbKey }) }));
      setKey("");
      setSaved(tmdbKey ? t("controlAdmin:apps.metadata.savedKey") : t("controlAdmin:apps.metadata.removedKey"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:apps.metadata.saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="config-block" id="video-metadata">
      <h3>{t("controlAdmin:apps.metadata.title")}</h3>
      <p className="muted">{t("controlAdmin:apps.metadata.intro")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:apps.metadata.loadFailed")}>{error}</MessageBox>}
      {state && (
        <form className="security-policy-form" onSubmit={(event) => { event.preventDefault(); if (key.trim()) void put(key.trim()); }}>
          <p>
            {state.hasKey
              ? t("controlAdmin:apps.metadata.hasKey", { hint: state.keyHint })
              : t("controlAdmin:apps.metadata.noKey")}
          </p>
          <label className="security-setting-row">
            <span className="security-setting-copy">
              <span className="security-setting-label">{state.hasKey ? t("controlAdmin:apps.metadata.replaceLabel") : t("controlAdmin:apps.metadata.keyLabel")}</span>
              <span className="security-setting-help">
                <Trans
                  i18nKey="apps.metadata.keyHelp"
                  ns="controlAdmin"
                  components={{ link: <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer noopener" /> }}
                />
              </span>
            </span>
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
          {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{saved}</MessageBox>}
          <div className="security-policy-actions">
            {state.hasKey && (
              <Button variant="secondary" disabled={busy !== null} onClick={() => void put(null)}>
                {busy === "remove" ? t("controlAdmin:apps.metadata.removing") : t("controlAdmin:apps.metadata.remove")}
              </Button>
            )}
            <Button variant="primary" type="submit" disabled={busy !== null || !key.trim()}>
              <KeyRound size={16} aria-hidden="true" />
              {busy === "save" ? t("controlAdmin:apps.metadata.checking") : t("controlAdmin:apps.metadata.save")}
            </Button>
          </div>
        </form>
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
    if (app === "video" && capability === "browse") return { name: t("controlAdmin:apps.access.capVideoBrowse"), means: t("controlAdmin:apps.access.capVideoBrowseMeans") };
    if (app === "video" && capability === "watch") return { name: t("controlAdmin:apps.access.capVideoWatch"), means: t("controlAdmin:apps.access.capVideoWatchMeans") };
    if (app === "video" && capability === "devices") return { name: t("controlAdmin:apps.access.capVideoDevices"), means: t("controlAdmin:apps.access.capVideoDevicesMeans") };
    if (app === "video" && capability === "manage") return { name: t("controlAdmin:apps.access.capVideoManage"), means: t("controlAdmin:apps.access.capVideoManageMeans") };
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

          {current.id === "video" && <StremioLinksBlock />}
        </>
      )}
    </>
  );
}

/** GET /api/apps/admin/video/stremio-links (modules/library/video/stremio.ts). */
interface MemberStremioLink {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  userId: string;
  userName: string;
}

// Every member's Stremio links, for revoking one when a device is lost or given
// away (docs/stremio-plan.md). Members make and revoke their own in Profile.
function StremioLinksBlock() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [links, setLinks] = useState<MemberStremioLink[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<MemberStremioLink | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      setLinks((await api<{ links: MemberStremioLink[] }>("/api/apps/admin/video/stremio-links")).links);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:stremio.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (link: MemberStremioLink) => link.label || t("controlAdmin:stremio.defaultLabel");

  const revoke = async () => {
    if (!pending) return;
    setRevoking(true);
    try {
      await api(`/api/apps/admin/video/stremio-links/${pending.id}`, { method: "DELETE" });
      setPending(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:stremio.revokeFailed"));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <section className="config-block" id="app-access-stremio">
      <h2>{t("controlAdmin:stremio.adminTitle")}</h2>
      <p className="muted">{t("controlAdmin:stremio.adminIntro")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:stremio.loadFailed")}>{error}</MessageBox>}
      {links && links.length === 0 && <p className="muted">{t("controlAdmin:stremio.adminEmpty")}</p>}
      {links && links.length > 0 && (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>{t("controlAdmin:stremio.colMember")}</th>
                <th>{t("controlAdmin:stremio.colDevice")}</th>
                <th>{t("controlAdmin:stremio.colAdded")}</th>
                <th>{t("controlAdmin:stremio.colLastUsed")}</th>
                <th aria-label={t("controlAdmin:stremio.revoke")} />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td>{link.userName}</td>
                  <td>{nameOf(link)}</td>
                  <td>{formatManagedDate(link.createdAt)}</td>
                  <td>{link.lastSeen ? formatManagedDate(link.lastSeen) : t("controlAdmin:stremio.never")}</td>
                  <td>
                    <Button
                      variant="icon"
                      danger
                      title={t("controlAdmin:stremio.revoke")}
                      aria-label={t("controlAdmin:stremio.revokeMemberAria", { name: link.userName, label: nameOf(link) })}
                      onClick={() => setPending(link)}
                    >
                      <Trash2 size={18} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pending && (
        <ConfirmDialog
          title={t("controlAdmin:stremio.adminConfirmTitle", { name: pending.userName, label: nameOf(pending) })}
          confirmLabel={t("controlAdmin:stremio.revoke")}
          busyLabel={t("controlAdmin:stremio.revoking")}
          danger
          busy={revoking}
          onConfirm={revoke}
          onCancel={() => setPending(null)}
        >
          {t("controlAdmin:stremio.adminConfirmBody", { name: pending.userName })}
        </ConfirmDialog>
      )}
    </section>
  );
}

// ── Setup: pairing ──────────────────────────────────────────────────────────

// Pairing a container with this server (docs/apps-platform-plan.md → Pairing):
// where it is (saved here), the secret both sides sign with (made here, shown
// once), what to set on the container, and a test. An address or a secret in
// this container's environment wins, and that half of Setup stays off while it is set.
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
  const [address, setAddress] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressError, setAddressError] = useState("");

  // The field starts from what is saved, again whenever another app is chosen
  // or the saved address changes.
  const currentId = current?.id;
  const currentUrl = current?.url ?? "";
  useEffect(() => {
    setAddress(currentUrl);
    setAddressError("");
  }, [currentId, currentUrl]);

  const saveAddress = async () => {
    if (!current) return;
    setSavingAddress(true);
    setAddressError("");
    try {
      await api(`/api/apps/admin/address/${encodeURIComponent(current.id)}`, { method: "PUT", body: JSON.stringify({ url: address }) });
      setTested(false);
      await load().catch(() => undefined);
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : t("controlAdmin:apps.setup.addressSaveFailed"));
    } finally {
      setSavingAddress(false);
    }
  };

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
            <p className="muted">{t("controlAdmin:apps.setup.addressIntro")}</p>

            {current.urlSource === "environment" ? (
              <MessageBox tone="info" title={t("controlAdmin:apps.setup.fromEnvironmentTitle")}>
                <Trans i18nKey="apps.setup.addressFromEnvironmentBody" ns="controlAdmin" values={{ variable: current.variables.url }} components={{ code: <code /> }} />
              </MessageBox>
            ) : (
              <form
                className="app-setup-address"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAddress();
                }}
              >
                <Field
                  label={t("controlAdmin:apps.setup.addressLabel")}
                  value={address}
                  onChange={setAddress}
                  placeholder={current.exampleUrl}
                  autoComplete="off"
                  required={false}
                  disabled={savingAddress}
                />
                <Button type="submit" variant="primary" disabled={savingAddress || address.trim() === (current.url ?? "")}>
                  {savingAddress ? t("controlAdmin:apps.setup.addressSaving") : t("controlAdmin:apps.setup.addressSave")}
                </Button>
              </form>
            )}
            {addressError && <MessageBox tone="error" title={t("controlAdmin:apps.setup.addressSaveFailed")}>{addressError}</MessageBox>}

            <dl className="games-status">
              <div>
                <dt>{t("controlAdmin:apps.setup.addressLabel")}</dt>
                <dd>{current.url ? <code>{current.url}</code> : t("controlAdmin:apps.setup.addressUnset")}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:apps.card.container")}</dt>
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

// What a container recorded: refused callers, invitations, finished matches,
// moves thrown out, errors. Asked of the container through the gateway, which
// forwards this admin's role; nothing is kept here.
export function AppEvents({ prefix }: { prefix: string }) {
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
