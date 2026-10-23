import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Gamepad2, Link2Off } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { Pager } from "../../../shared/Pager";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectField } from "../../../shared/SelectField";
import { formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";

interface GamesStatus {
  configured: boolean;
  reason: string | null;
  url: string | null;
  secretSet: boolean;
  /** Whether the games server takes this app's signature; null = not asked or unknown. */
  secretAccepted: boolean | null;
  server: { ok: boolean; version: string | null; error: string | null } | null;
}

type EventLevel = "info" | "warn" | "error";
type LevelFilter = "all" | EventLevel;

interface GamesEvent {
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
  events: GamesEvent[];
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

// pino's numeric levels, for the log lines the games server hands over raw.
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
  // Local time, like the events table above it.
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

// Settings → Games: how the link to isputnik.games stands, and — once it is on —
// the admin's window into the games container: the events it recorded and the
// newest lines of its log, read through the gateway (docs/games-platform-plan.md
// → Logging). Read-only by design: the two settings are environment variables
// on the container, the way the owner decided, so this page shows what they are
// set to and whether the games server answers — not fields to edit. The secret
// is never shown, only whether one is set.
export function GamesSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [status, setStatus] = useState<GamesStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api<GamesStatus>("/api/games/admin/status")
        .then((payload) => { setStatus(payload); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.loadFailed")); throw err; }),
    [t]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const dash = "—";
  const state = !status ? null : !status.configured ? "off" : !status.server?.ok ? "unreachable" : status.secretAccepted === false ? "refused" : "on";

  return (
    <>
      <ControlSectionHead
        section="games"
        icon={<Gamepad2 size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:games.headDescription")}
      />

      <section className="config-block">
        <p className="muted">{t("controlAdmin:games.intro")}</p>

        {error && <MessageBox tone="error" title={t("controlAdmin:games.loadFailed")}>{error}</MessageBox>}
        {!status && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}

        {status && (
          <>
            {state === "on" && (
              <MessageBox tone="success" title={t("controlAdmin:games.onTitle")}>
                {t("controlAdmin:games.onBody", { version: status.server?.version ?? dash })}
              </MessageBox>
            )}
            {state === "unreachable" && (
              <MessageBox tone="warning" title={t("controlAdmin:games.unreachableTitle")}>
                {t("controlAdmin:games.unreachableBody", { url: status.url ?? dash, error: status.server?.error ?? dash })}
              </MessageBox>
            )}
            {state === "refused" && (
              <MessageBox tone="error" title={t("controlAdmin:games.refusedTitle")}>
                {t("controlAdmin:games.refusedBody")}
              </MessageBox>
            )}
            {state === "off" && (
              <MessageBox tone="info" title={t("controlAdmin:games.offTitle")}>
                {status.reason ?? t("controlAdmin:games.offBody")}
              </MessageBox>
            )}

            <dl className="games-status" aria-label={t("controlAdmin:games.statusLabel")}>
              <div>
                <dt>{t("controlAdmin:games.gateway")}</dt>
                <dd>{status.configured ? t("controlAdmin:games.gatewayOn") : t("controlAdmin:games.gatewayOff")}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.url")}</dt>
                <dd>{status.url ? <code>{status.url}</code> : dash}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.secret")}</dt>
                <dd>
                  {!status.secretSet
                    ? t("controlAdmin:games.secretUnset")
                    : status.secretAccepted === true
                      ? t("controlAdmin:games.secretAccepted")
                      : status.secretAccepted === false
                        ? t("controlAdmin:games.secretRefused")
                        : t("controlAdmin:games.secretSet")}
                </dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.server")}</dt>
                <dd>
                  {!status.server
                    ? t("controlAdmin:games.serverNotAsked")
                    : status.server.ok
                      ? t("controlAdmin:games.serverVersion", { version: status.server.version ?? dash })
                      : status.server.error ?? t("controlAdmin:games.serverDown")}
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
              <RefreshButton onRefresh={load} label={t("controlAdmin:games.checkAgain")} compact={false} />
            </div>
          </>
        )}
      </section>

      {status?.configured && <GuestLinks />}
      {state === "on" && (
        <>
          <GamesEvents />
          <GamesLog />
        </>
      )}
    </>
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
              <table className="datagrid games-events-table">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:games.guestColGuest")}</th>
                    <th>{t("controlAdmin:games.guestColGame")}</th>
                    <th>{t("controlAdmin:games.guestColInvitedBy")}</th>
                    <th>{t("controlAdmin:games.guestColState")}</th>
                    <th>{t("controlAdmin:games.guestColOpened")}</th>
                    <th aria-label={t("controlAdmin:games.guestColActions")} />
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
                      <td>
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

// What the games container recorded: refused callers, invitations, finished
// matches, moves thrown out, errors. Asked of the games server through the
// gateway, which forwards this admin's role; nothing is kept here.
function GamesEvents() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EventsPage | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (level !== "all") params.set("level", level);
    return api<EventsPage>(`/games/api/admin/events?${params}`)
      .then((payload) => { setData(payload); setError(""); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.eventsLoadFailed")); throw err; });
  }, [level, page, t]);

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
    <section className="config-block" id="games-events">
      <h3>{t("controlAdmin:games.eventsTitle")}</h3>
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

// The newest lines of the games container's log, from the ring buffer its
// server keeps — what `docker logs` would show, without a shell on the host.
function GamesLog() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [tail, setTail] = useState<LogTail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    () =>
      api<LogTail>(`/games/api/admin/log?lines=${LOG_LINES}`)
        .then((payload) => { setTail(payload); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.logLoadFailed")); throw err; }),
    [t]
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
    <section className="config-block" id="games-log">
      <h3>{t("controlAdmin:games.logTitle")}</h3>
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
