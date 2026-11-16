import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Layers, ShieldAlert, Smartphone, Users, Wifi } from "lucide-react";
import { api } from "../../../api";
import { initials } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Pager } from "../../../shared/Pager";
import { StatTiles } from "../../../shared/StatTiles";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes } from "../../../shared/utils";

// Device Sync › Statistics (owner, 2026-11-16): a page to look at, not a second log.
// Who backs up, from what, into how much — the personal libraries against their
// size limit, and the devices and where they last came from, each table paged. Built from what Device Sync already keeps:
// never a count of photos a phone sent, never a file (docs/photo-sync-plan.md,
// phase 4's privacy line). Every event stays in Logs, linked from Device Sync.

export interface StatsPhone {
  id: string;
  label: string | null;
  lastSeen: string | null;
  network: string | null;
  member: { id: string; name: string };
  stale: boolean;
  problem: { current: boolean } | null;
}

interface PersonalAdmin {
  settings: { enabled: boolean; sizeLimitGB: number | null };
  libraries: { id: string; ownerId: string; ownerName: string; orphanedAt: string | null; sizeBytes: number; phones: number }[];
}

interface Member { id: string; displayName: string; isActive?: boolean }

const GB = 1024 ** 3;
/** Rows a table shows before it pages. */
const PAGE_SIZE = 10;

/** One page of a list, and the page to show — kept in range as the list shrinks. */
function usePaged<T>(items: T[]): { rows: T[]; page: number; totalPages: number; setPage: (page: number) => void } {
  const [wanted, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(wanted, totalPages);
  return { rows: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, totalPages, setPage };
}
const DAY = 86_400_000;

type Tone = "blue" | "gold" | "rose" | "mint" | "ok" | "warn";

/** One card of the page: a coloured icon, a title, one line of what it adds up to,
 *  and its table edge to edge. */
function Section({ title, summary, icon, tone, children }: { title: string; summary?: ReactNode; icon: ReactNode; tone: Tone; children: ReactNode }) {
  return (
    <section className="stats-card" aria-label={title}>
      <header className="stats-card-head">
        <span className={`stat-tile-icon is-${tone}`} aria-hidden="true">{icon}</span>
        <div>
          <h3>{title}</h3>
          {summary && <small>{summary}</small>}
        </div>
      </header>
      {children}
    </section>
  );
}

/** A person: their initials in a circle, then the name. */
function Person({ name, note }: { name: string; note?: ReactNode }) {
  return (
    <span className="stats-person">
      <span className="stats-avatar" aria-hidden="true">{initials(name)}</span>
      <span>{name}{note && <small>{note}</small>}</span>
    </span>
  );
}

/** When something last happened, with a dot: green lately, amber when it has gone quiet. */
function When({ text, quiet, none }: { text: string; quiet: boolean; none?: boolean }) {
  return <span className={`stats-when${none ? " is-none" : quiet ? " is-warn" : " is-ok"}`}><i aria-hidden="true" />{text}</span>;
}

export function DeviceSyncStats<P extends StatsPhone>({ phones, phoneName, onOpenPhone }: {
  phones: P[];
  phoneName: (phone: P) => string;
  onOpenPhone: (id: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [personal, setPersonal] = useState<PersonalAdmin | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [refused, setRefused] = useState<number | null>(null);
  const [error, setError] = useState("");
  // The clock read once, when the page opens: what counts as quiet holds still while it is open.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const failed = (err: unknown) => setError(err instanceof Error ? err.message : t("controlAdmin:deviceSync.statsFailed"));
    // Each part on its own, so one that fails leaves the others standing.
    api<PersonalAdmin>("/api/storage/personal-libraries").then(setPersonal, failed);
    api<{ users: Member[] }>("/api/users").then((users) => setMembers(users.users.filter((user) => user.isActive !== false)), failed);
    // Only the total is wanted; the log's smallest page is 10 rows.
    api<{ total: number }>(`/api/logs?${new URLSearchParams({ event: "photo_sync.refused", from: since, pageSize: "10" }).toString()}`)
      .then((refusals) => setRefused(refusals.total), failed);
  }, [t]);

  // A member's phones, and when the newest of them last backed up.
  const byMember = useMemo(() => {
    const map = new Map<string, { phones: number; lastSeen: string | null }>();
    for (const phone of phones) {
      const entry = map.get(phone.member.id) ?? { phones: 0, lastSeen: null };
      entry.phones += 1;
      if (phone.lastSeen && (!entry.lastSeen || phone.lastSeen > entry.lastSeen)) entry.lastSeen = phone.lastSeen;
      map.set(phone.member.id, entry);
    }
    return map;
  }, [phones]);

  const quiet = phones.filter((phone) => phone.stale || phone.problem?.current).length;
  const libraries = (personal?.libraries ?? []).filter((library) => !library.orphanedAt);
  const totalBytes = libraries.reduce((sum, library) => sum + library.sizeBytes, 0);
  const limitBytes = personal?.settings.sizeLimitGB != null ? personal.settings.sizeLimitGB * GB : null;
  const when = (iso: string | null) => (iso ? relativeTime(iso) : t("controlAdmin:phoneSyncPage.never"));
  const isQuiet = (iso: string | null) => !iso || now - Date.parse(iso) > 7 * DAY;

  const membersWithPhones = byMember.size;
  const libraryPages = usePaged(libraries);
  const phonePages = usePaged(phones);
  const usedShare = limitBytes && libraries.length ? Math.round((totalBytes / (limitBytes * libraries.length)) * 100) : null;

  return (
    <div className="device-sync-stats">
      {error && <MessageBox tone="error" title={t("controlAdmin:deviceSync.statsFailed")}>{error}</MessageBox>}

      <StatTiles
        label={t("controlAdmin:deviceSync.statsLabel")}
        tiles={[
          { icon: <Smartphone size={18} />, iconTone: "blue", label: t("controlAdmin:phoneSyncPage.phonesHeading"), value: phones.length, sub: quiet > 0 ? t("controlAdmin:deviceSync.quietCount", { count: quiet }) : undefined, tone: quiet > 0 ? "warn" : undefined },
          { icon: <Users size={18} />, iconTone: "mint", label: t("controlAdmin:deviceSync.membersBackingUp"), value: membersWithPhones, sub: members ? t("controlAdmin:deviceSync.ofMembers", { count: members.length }) : undefined },
          { icon: <HardDrive size={18} />, iconTone: "gold", label: t("controlAdmin:personalLibraries.title"), value: personal ? formatBytes(totalBytes) : "…", sub: personal ? t("controlAdmin:deviceSync.inLibraries", { count: libraries.length }) : undefined },
          { icon: <ShieldAlert size={18} />, iconTone: "ok", label: t("controlAdmin:deviceSync.refused30"), value: refused ?? "…", tone: refused ? "warn" : undefined }
        ]}
      />

      <Section
        icon={<Layers size={18} />}
        tone="gold"
        title={t("controlAdmin:personalLibraries.title")}
        summary={limitBytes
          ? t("controlAdmin:deviceSync.librariesSummaryLimit", { size: personal?.settings.sizeLimitGB, share: usedShare ?? 0 })
          : t("controlAdmin:deviceSync.librariesSummary")}
      >
        <table className="datagrid datagrid-phone-stack stats-table">
          <thead>
            <tr>
              <th>{t("controlAdmin:deviceSync.colMember")}</th>
              <th>{limitBytes ? t("controlAdmin:deviceSync.colUsedOf", { size: personal?.settings.sizeLimitGB }) : t("controlAdmin:deviceSync.colSize")}</th>
              <th className="col-num">{t("controlAdmin:phoneSyncPage.phonesHeading")}</th>
              <th>{t("controlAdmin:deviceSync.lastBackup")}</th>
            </tr>
          </thead>
          <tbody>
            {personal && libraries.length === 0 && <tr><td colSpan={4} className="datagrid-muted">{t("controlAdmin:personalLibraries.none")}</td></tr>}
            {libraryPages.rows.map((library) => {
              const share = limitBytes ? Math.min(100, Math.round((library.sizeBytes / limitBytes) * 100)) : null;
              const last = byMember.get(library.ownerId)?.lastSeen ?? null;
              return (
                <tr key={library.id}>
                  <td><Person name={library.ownerName} /></td>
                  <td className="stats-usage">
                    <span className="stats-usage-text"><strong>{formatBytes(library.sizeBytes)}</strong>{share != null && <small>{share}%</small>}</span>
                    {share != null && (
                      <span className={`stats-bar${share >= 90 ? " is-warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-label={t("controlAdmin:deviceSync.usedAria", { name: library.ownerName })}>
                        <i style={{ width: `${Math.max(share, 2)}%` }} />
                      </span>
                    )}
                  </td>
                  <td className="col-num" data-label={t("controlAdmin:phoneSyncPage.phonesHeading")}>{library.phones}</td>
                  <td><When text={when(last)} quiet={isQuiet(last)} none={!last} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="stats-card-foot">
          <Pager page={libraryPages.page} totalPages={libraryPages.totalPages} onChange={libraryPages.setPage} label={t("controlAdmin:deviceSync.librariesPager")} />
        </div>
      </Section>

      <Section
        icon={<Smartphone size={18} />}
        tone="blue"
        title={t("controlAdmin:deviceSync.statsDevices")}
        summary={quiet > 0 ? t("controlAdmin:deviceSync.devicesSummaryQuiet", { count: phones.length, quiet }) : t("controlAdmin:deviceSync.devicesSummary", { count: phones.length })}
      >
        <table className="datagrid datagrid-phone-stack stats-table">
          <thead>
            <tr>
              <th>{t("controlAdmin:deviceSync.colPhone")}</th>
              <th>{t("controlAdmin:deviceSync.colMember")}</th>
              <th>{t("controlAdmin:deviceSync.colNetwork")}</th>
              <th>{t("controlAdmin:deviceSync.lastContact")}</th>
            </tr>
          </thead>
          <tbody>
            {phones.length === 0 && <tr><td colSpan={4} className="datagrid-muted">{t("controlAdmin:deviceSync.noPhonesRow")}</td></tr>}
            {phonePages.rows.map((phone) => (
              <tr key={phone.id}>
                <td>
                  <a className="stats-device" href={`?show=phone:${encodeURIComponent(phone.id)}`} onClick={(event) => { event.preventDefault(); onOpenPhone(phone.id); }}>
                    <span className="stats-device-icon" aria-hidden="true"><Smartphone size={15} /></span>
                    {phoneName(phone)}
                  </a>
                </td>
                <td><Person name={phone.member.name} /></td>
                <td>{phone.network ? <span className="stats-chip"><Wifi size={13} aria-hidden="true" /> {phone.network}</span> : <span className="datagrid-muted">—</span>}</td>
                <td><When text={when(phone.lastSeen)} quiet={phone.stale || Boolean(phone.problem?.current)} none={!phone.lastSeen} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="stats-card-foot">
          <Pager page={phonePages.page} totalPages={phonePages.totalPages} onChange={phonePages.setPage} label={t("controlAdmin:deviceSync.devicesPager")} />
        </div>
      </Section>

    </div>
  );
}
