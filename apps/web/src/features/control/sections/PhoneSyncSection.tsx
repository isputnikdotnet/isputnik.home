import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, BookOpen, Link2, Plus, ScrollText, Smartphone, UserRoundCheck, Wifi } from "lucide-react";
import { api } from "../../../api";
import { libraryManageHref, memberHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { ActionRow, AddRow, CommandRow, GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SettingsCard } from "../../../shared/SettingsCard";
import { StatTiles } from "../../../shared/StatTiles";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { ControlBackBar } from "../ControlBackBar";
import { ControlSectionHead } from "../ControlSectionHead";
import { logsHref } from "../links";
import { DeviceSyncStats } from "./DeviceSyncStats";
import { PersonalLibrariesPanel } from "./storage/PersonalLibrariesPanel";
import type { StorageRoot } from "../types";

// Applications › Gallery › Device Sync (docs/photo-sync-plan.md; control panel v2):
// members' phones backing up their photos to this server. Laid out like a phone's
// Settings app (owner, 2026-11-12): one column of grouped rows, each showing its
// value and opening a small page — a phone, a network, the address, the personal
// libraries — with Back. One status line on top says whether phone backup is on;
// while it is not, that line is the setup steps instead.
//
// The privacy line of phase 4 holds: never counts of what a phone sent, never files
// or file types — the state of each phone, and where it last came from.

/** Only problems about the phone or the server reach an admin (server: ADMIN_PROBLEMS). */
type AdminProblem = "not_listed" | "proxy" | "quota" | "disk_full" | "library_unavailable";

interface OverviewPhone {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  /** The phone-sync network its last address falls in (label, else the range). */
  network: string | null;
  member: { id: string; name: string };
  problem: { code: AdminProblem; detail: string | null; at: string; current: boolean } | null;
  stale: boolean;
  nearLimit: boolean;
  atLimit: boolean;
  /** Refused from an address on no list: the /24 to offer as the fix. */
  suggestedRange: string | null;
  /** The libraries whose photos it doesn't send again (each library's Phone backups tab). */
  links: Array<{ libraryId: string; name: string; counts: boolean }>;
}

interface SyncNetwork { id: string; cidr: string; label: string | null; createdAt: string }

interface NetworksView {
  networks: SyncNetwork[];
  /** "Address phones use", e.g. http://192.168.2.10:4000; null until an admin types it. */
  address: string | null;
  addressOutsideNetworks: boolean;
}

interface PersonalView {
  settings: { enabled: boolean };
  libraries: Array<{ id: string; name: string; ownerName: string; sizeBytes: number; phones: number }>;
}

/** Which page of Device Sync is open — in the address (?show=), so Back and links work. */
type Show =
  | { page: "list" }
  | { page: "phone"; id: string }
  | { page: "network"; id: string }
  | { page: "addNetwork" }
  | { page: "address" }
  | { page: "stats" }
  | { page: "adopt" };

function parseShow(value: string): Show {
  if (value.startsWith("phone:")) return { page: "phone", id: value.slice(6) };
  if (value.startsWith("network:")) return { page: "network", id: value.slice(8) };
  if (value === "add-network") return { page: "addNetwork" };
  if (value === "address") return { page: "address" };
  if (value === "stats" || value === "activity") return { page: "stats" };
  if (value === "personal-library") return { page: "adopt" };
  return { page: "list" };
}

function showParam(show: Show): string | null {
  switch (show.page) {
    case "phone": return `phone:${show.id}`;
    case "network": return `network:${show.id}`;
    case "addNetwork": return "add-network";
    case "address": return "address";
    case "stats": return "stats";
    case "adopt": return "personal-library";
    default: return null;
  }
}

/** Which page is open lives in ?show= (shared/useQueryPage): a step in is a history
 *  entry, and returning to the list steps back rather than adding the list again. */
function useShow(): [Show, (next: Show) => void] {
  const [value, setValue] = useQueryPage("show");
  const show = useMemo(() => parseShow(value ?? ""), [value]);
  const go = useCallback((next: Show) => setValue(showParam(next)), [setValue]);
  return [show, go];
}

const daysSince = (iso: string) => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

export function PhoneSyncSection() {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [show, go] = useShow();
  const [phones, setPhones] = useState<OverviewPhone[] | null>(null);
  const [networks, setNetworks] = useState<NetworksView | null>(null);
  const [personal, setPersonal] = useState<PersonalView | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<OverviewPhone | null>(null);
  // Set by the "need attention" link: Statistics opens scrolled to its devices.
  const [focusDevices, setFocusDevices] = useState(false);

  const load = useCallback(async () => {
    const [phoneView, networkView, personalView] = await Promise.all([
      api<{ phones: OverviewPhone[] }>("/api/photo-sync/phones"),
      api<NetworksView>("/api/photo-sync/networks"),
      api<PersonalView>("/api/storage/personal-libraries").catch(() => null)
    ]);
    setPhones(phoneView.phones);
    setNetworks(networkView);
    setPersonal(personalView);
    setError("");
  }, []);

  const loadQuietly = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed"));
    }
  }, [load, t]);
  useEffect(() => { void loadQuietly(); }, [loadQuietly]);

  // The personal-library settings pick their folder from the library locations.
  useEffect(() => {
    if (storageRoots) return;
    api<{ roots: StorageRoot[] }>("/api/storage/roots")
      .then((payload) => setStorageRoots(payload.roots))
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed")));
  }, [storageRoots, t]);

  /** A change: made, the page read again, and back where it was asked for. */
  const act = async (work: () => Promise<unknown>, after?: Show) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
      if (after) go(after);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSync.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const phoneName = (phone: OverviewPhone) => phone.label || t("controlAdmin:member.phones.unnamed");

  const problemText = (problem: NonNullable<OverviewPhone["problem"]>) => ({
    not_listed: t("controlAdmin:member.phones.problem.not_listed", { detail: problem.detail ?? "" }),
    proxy: t("controlAdmin:member.phones.problem.proxy"),
    quota: t("controlAdmin:member.phones.problem.quota"),
    disk_full: t("controlAdmin:member.phones.problem.disk_full"),
    library_unavailable: t("controlAdmin:member.phones.problem.library_unavailable")
  }[problem.code]);

  /** The one word for a phone in the list, and whether it wants a look. */
  const shortState = (phone: OverviewPhone): { text: string; warn: boolean } => {
    if (phone.problem?.current) return { text: t("controlAdmin:deviceSync.stateProblem"), warn: true };
    if (phone.stale) return { text: t("controlAdmin:deviceSync.stateStale", { count: daysSince(phone.lastSeen ?? phone.createdAt) }), warn: true };
    if (phone.atLimit) return { text: t("controlAdmin:phoneSyncPage.stateAtLimit"), warn: true };
    if (phone.nearLimit) return { text: t("controlAdmin:phoneSyncPage.stateNearLimit"), warn: true };
    if (phone.lastSeen) return { text: t("controlAdmin:deviceSync.stateOk", { when: relativeTime(phone.lastSeen) }), warn: false };
    return { text: t("controlAdmin:phoneSyncPage.stateWaiting"), warn: false };
  };

  const head = (
    <ControlSectionHead section="phoneSync" icon={<Smartphone size={30} />} iconClassName="blue" description={t("controlAdmin:deviceSync.description")}>
      <RefreshButton
        onRefresh={async () => {
          try {
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed"));
            throw err;
          }
        }}
      />
    </ControlSectionHead>
  );

  const backToList = (
    <ControlBackBar section="phoneSync" list={{ href: queryPageHref(null), label: t("control:nav.tabs.phoneSync") }} onBack={() => go({ page: "list" })} />
  );

  const errors = error && <MessageBox tone="error" title={t("controlAdmin:phoneSync.updateFailed")}>{error}</MessageBox>;

  if (!phones || !networks) {
    return (
      <>
        {head}
        {errors || <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
      </>
    );
  }

  const on = networks.networks.length > 0 && Boolean(networks.address);

  // ── A phone ────────────────────────────────────────────────────────────────
  if (show.page === "phone") {
    const phone = phones.find((candidate) => candidate.id === show.id);
    if (!phone) return <>{backToList}<p className="access-muted">{t("controlAdmin:deviceSync.gone")}</p></>;
    const state = shortState(phone);
    return (
      <div className="device-sync">
        {backToList}
        <div className="device-sync-title">
          <h1>{phoneName(phone)}</h1>
          <span className={`app-status-pill ${state.warn ? "is-needsSetup" : "is-ready"}`}>{state.text}</span>
        </div>
        {errors}
        {phone.suggestedRange && (
          <GroupedList note={t("controlAdmin:deviceSync.refusedNote")}>
            <InfoRow
              icon={<Wifi size={17} />}
              iconTone="warn"
              label={phone.problem ? problemText(phone.problem) : t("controlAdmin:deviceSync.stateProblem")}
              sub={phone.problem ? formatManagedDate(phone.problem.at) : undefined}
            />
            <ActionRow
              label={busy ? t("controlAdmin:phoneSyncPage.addingRange") : t("controlAdmin:deviceSync.allow", { range: phone.suggestedRange })}
              disabled={busy}
              onClick={() => void act(() => api("/api/photo-sync/networks", {
                method: "POST",
                body: JSON.stringify({ cidr: phone.suggestedRange, label: t("controlAdmin:phoneSyncPage.rangeLabel", { phone: phoneName(phone) }) })
              }))}
            />
          </GroupedList>
        )}
        <GroupedList title={t("controlAdmin:deviceSync.statusTitle")}>
          <NavRow label={t("controlAdmin:deviceSync.member")} value={phone.member.name} href={memberHref(phone.member.id)} />
          <InfoRow label={t("controlAdmin:deviceSync.lastContact")} value={phone.lastSeen ? formatManagedDate(phone.lastSeen) : t("controlAdmin:phoneSyncPage.never")} valueTone={state.warn ? "warn" : undefined} />
          <InfoRow label={t("controlAdmin:deviceSync.from")} value={phone.lastIp ? `${phone.network ?? t("controlAdmin:phoneSyncPage.noNetwork")} · ${phone.lastIp}` : "—"} />
          <InfoRow label={t("controlAdmin:deviceSync.added")} value={formatManagedDate(phone.createdAt)} />
          {phone.problem && !phone.problem.current && (
            <InfoRow label={t("controlAdmin:deviceSync.earlier")} sub={problemText(phone.problem)} value={formatManagedDate(phone.problem.at)} />
          )}
        </GroupedList>
        <GroupedList title={t("controlAdmin:deviceSync.backsUpInto")} note={t("controlAdmin:deviceSync.linksNote")}>
          {phone.links.length === 0 && <InfoRow icon={<BookOpen size={17} />} label={t("controlAdmin:deviceSync.ownLibrary")} />}
          {/* A library you cannot open (someone's personal one: no counts) is said, not
              linked — its Manage page would only say "Library not found". */}
          {phone.links.map((link) => link.counts
            ? <NavRow key={link.libraryId} icon={<BookOpen size={17} />} label={link.name} href={libraryManageHref(link.libraryId)} />
            : <InfoRow key={link.libraryId} icon={<BookOpen size={17} />} label={link.name} sub={t("controlAdmin:deviceSync.linkNoAccess")} />)}
        </GroupedList>
        <GroupedList>
          <NavRow icon={<ScrollText size={17} />} label={t("controlAdmin:deviceSync.phoneHistory")} value={t("controlAdmin:deviceSync.logs")} href={logsHref({ event: "photo_sync", q: phoneName(phone) })} />
        </GroupedList>
        <GroupedList note={t("controlAdmin:deviceSync.removeNote")}>
          <ActionRow tone="danger" label={t("controlAdmin:deviceSync.removePhone")} onClick={() => setConfirmRemove(phone)} />
        </GroupedList>
        {confirmRemove && (
          <ConfirmDialog
            title={t("controlAdmin:member.phones.revokeTitle", { name: phoneName(confirmRemove), member: confirmRemove.member.name })}
            confirmLabel={t("controlAdmin:deviceSync.removePhone")}
            busyLabel={t("controlAdmin:member.phones.revoking")}
            danger
            busy={busy}
            onCancel={() => setConfirmRemove(null)}
            onConfirm={() => {
              const target = confirmRemove;
              void act(
                () => api(`/api/photo-sync/members/${encodeURIComponent(target.member.id)}/phones/${encodeURIComponent(target.id)}`, { method: "DELETE" }),
                { page: "list" }
              ).then(() => setConfirmRemove(null));
            }}
          >
            {t("controlAdmin:member.phones.revokeBody", { member: confirmRemove.member.name })}
          </ConfirmDialog>
        )}
      </div>
    );
  }

  // ── A network ──────────────────────────────────────────────────────────────
  if (show.page === "network") {
    const network = networks.networks.find((candidate) => candidate.id === show.id);
    if (!network) return <>{backToList}<p className="access-muted">{t("controlAdmin:deviceSync.gone")}</p></>;
    return (
      <div className="device-sync">
        {backToList}
        <div className="device-sync-title"><h1>{network.label || network.cidr}</h1></div>
        {errors}
        <GroupedList>
          <InfoRow label={t("controlAdmin:deviceSync.range")} value={<code>{network.cidr}</code>} />
          <InfoRow label={t("controlAdmin:deviceSync.name")} value={network.label || "—"} />
          <InfoRow label={t("controlAdmin:deviceSync.added")} value={formatManagedDate(network.createdAt)} />
        </GroupedList>
        <GroupedList note={t("controlAdmin:deviceSync.removeNetworkNote")}>
          <ActionRow
            tone="danger"
            label={t("controlAdmin:phoneSync.remove")}
            disabled={busy}
            onClick={() => void act(() => api(`/api/photo-sync/networks/${network.id}`, { method: "DELETE" }), { page: "list" })}
          />
        </GroupedList>
      </div>
    );
  }

  // ── Statistics ─────────────────────────────────────────────────────────────
  // A page of the tab (owner, 2026-11-16): who backs up, from what, into how much —
  // not a second log; every event stays in Logs, linked at its foot. Under the
  // tables nothing to do: making a library personal has a page of its own.
  if (show.page === "stats") {
    return (
      // Tables want the overview's full width, not a settings page's 760px.
      <div className="device-sync device-sync-overview">
        {backToList}
        <div className="device-sync-title"><h1>{t("controlAdmin:deviceSync.statsPage")}</h1></div>
        {errors}
        <DeviceSyncStats phones={phones} phoneName={phoneName} phoneState={shortState} focusDevices={focusDevices} onFocused={() => setFocusDevices(false)} onOpenPhone={(id) => go({ page: "phone", id })} />
      </div>
    );
  }

  // ── Make a library personal ────────────────────────────────────────────────
  // A page of the tab (owner, 2026-11-16): which gallery library, whose — chosen in
  // the page, then confirmed — and, while there are any, the libraries of removed
  // members, to hand over or delete.
  if (show.page === "adopt") {
    return (
      <div className="device-sync">
        {backToList}
        <div className="device-sync-title"><h1>{t("controlAdmin:personalLibraries.adopt")}</h1></div>
        {errors}
        {storageRoots
          ? <PersonalLibrariesPanel part="actions" storageRoots={storageRoots} onChanged={() => void loadQuietly()} />
          : <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
      </div>
    );
  }

  // ── The page ───────────────────────────────────────────────────────────────
  // Stats across the top, then two columns, the diagnostics detail page's shape
  // (owner, 2026-11-16): the settings in the main one — personal libraries, allowed
  // networks, the server address — and on the right what there is (the phones, the
  // personal libraries) and where to read more (Log, Activity, the guide). While
  // phone backup is not set up, the three steps that set it up come first.
  const lastBackup = phones.map((phone) => phone.lastSeen).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  const warnCount = phones.filter((phone) => shortState(phone).warn).length;
  const personalBytes = (personal?.libraries ?? []).reduce((sum, library) => sum + library.sizeBytes, 0);
  return (
    <>
      {head}
      <div className="device-sync device-sync-overview">
        {errors}
        {!on && (
          <SettingsCard icon={<Smartphone size={20} />} title={t("controlAdmin:deviceSync.setupTitle")} note={t("controlAdmin:deviceSync.setupNote")}>
          <GroupedList>
            <NavRow
              icon={<Wifi size={17} />}
              iconTone={networks.networks.length ? "ok" : "warn"}
              label={t("controlAdmin:deviceSync.stepNetwork")}
              value={networks.networks.length ? t("controlAdmin:deviceSync.networkCount", { count: networks.networks.length }) : t("controlAdmin:deviceSync.noneYet")}
              onClick={() => go({ page: "addNetwork" })}
            />
            <NavRow
              icon={<Link2 size={17} />}
              iconTone={networks.address ? "ok" : "warn"}
              label={t("controlAdmin:deviceSync.stepAddress")}
              value={networks.address ?? t("controlAdmin:deviceSync.notSet")}
              onClick={() => go({ page: "address" })}
            />
            <NavRow
              icon={<Smartphone size={17} />}
              label={t("controlAdmin:deviceSync.stepPhone")}
              sub={t("controlAdmin:deviceSync.stepPhoneSub")}
              value={t("controlAdmin:deviceSync.guide")}
              href="/help/phone-sync-setup"
            />
          </GroupedList>
          </SettingsCard>
        )}

        <StatTiles
          label={t("controlAdmin:deviceSync.statsLabel")}
          tiles={[
            {
              label: t("controlAdmin:phoneSyncPage.phonesHeading"),
              value: phones.length,
              sub: warnCount > 0 ? t("controlAdmin:deviceSync.needAttention", { count: warnCount }) : undefined,
              tone: warnCount > 0 ? "warn" : undefined,
              // Which phones, and why (not seen for a week, refused, full): Statistics' Devices.
              onSubClick: warnCount > 0 ? () => { setFocusDevices(true); go({ page: "stats" }); } : undefined
            },
            {
              label: t("controlAdmin:personalLibraries.title"),
              value: personal ? (personal.settings.enabled || personal.libraries.length > 0 ? personal.libraries.length : t("controlAdmin:deviceSync.off")) : "…",
              sub: personal && personal.libraries.length > 0 ? formatBytes(personalBytes) : undefined
            },
            {
              label: t("controlAdmin:deviceSync.lastBackup"),
              value: lastBackup ? relativeTime(lastBackup) : t("controlAdmin:phoneSyncPage.never")
            },
            {
              label: t("controlAdmin:deviceSync.cardNetworks"),
              value: networks.networks.length,
              sub: networks.networks.length === 0 ? t("controlAdmin:deviceSync.noneYet") : undefined,
              tone: networks.networks.length === 0 ? "warn" : undefined
            }
          ]}
        />

        <div className="device-sync-page">
          <div className="device-sync-main">
            {storageRoots
              ? <PersonalLibrariesPanel part="settings" storageRoots={storageRoots} onChanged={() => void loadQuietly()} />
              : <p className="access-muted">{t("controlAdmin:access.loading")}</p>}

            <GroupedList id="phone-sync-networks" title={t("controlAdmin:deviceSync.cardNetworks")} note={t("controlAdmin:deviceSync.networksNote")}>
              <AddRow icon={<Plus size={17} />} label={t("controlAdmin:phoneSync.add")} onClick={() => go({ page: "addNetwork" })} />
              {networks.networks.map((network) => (
                <NavRow
                  key={network.id}
                  icon={<Wifi size={17} />}
                  label={network.label || network.cidr}
                  sub={network.label ? network.cidr : undefined}
                  onClick={() => go({ page: "network", id: network.id })}
                />
              ))}
            </GroupedList>

            <GroupedList title={t("controlAdmin:deviceSync.cardAddress")} note={t("controlAdmin:deviceSync.addressNote")}>
              <CommandRow
                icon={<Link2 size={17} />}
                iconTone={networks.address && networks.addressOutsideNetworks ? "warn" : undefined}
                label={networks.address ?? t("controlAdmin:deviceSync.notSet")}
                sub={networks.address && networks.addressOutsideNetworks ? t("controlAdmin:phoneSync.outsideTitle") : t("controlAdmin:phoneSync.addressHeading")}
                value={networks.address ? t("controlAdmin:personalLibraries.change") : t("controlAdmin:deviceSync.setAddress")}
                onClick={() => go({ page: "address" })}
              />
            </GroupedList>
          </div>

          <aside className="device-sync-aside" aria-label={t("controlAdmin:deviceSync.moreTitle")}>
            <GroupedList title={t("controlAdmin:deviceSync.moreTitle")}>
              {/* One way to the events: the Logs page, filtered to phone backup. */}
              <NavRow
                icon={<BarChart3 size={17} />}
                label={t("controlAdmin:deviceSync.statsPage")}
                sub={t("controlAdmin:deviceSync.statsPageSub", {
                  phones: t("controlAdmin:personalLibraries.phonesCount", { count: phones.length }),
                  libraries: t("controlAdmin:personalLibraries.librariesCount", { count: personal?.libraries.length ?? 0 })
                })}
                onClick={() => go({ page: "stats" })}
              />
              <NavRow
                icon={<UserRoundCheck size={17} />}
                label={t("controlAdmin:personalLibraries.adopt")}
                sub={t("controlAdmin:deviceSync.adoptSub")}
                onClick={() => go({ page: "adopt" })}
              />
              <NavRow icon={<ScrollText size={17} />} label={t("controlAdmin:diagnostics.page.logs.log")} sub={t("controlAdmin:deviceSync.logSub")} href={logsHref({ event: "photo_sync" })} />
              <NavRow icon={<BookOpen size={17} />} label={t("controlAdmin:deviceSync.guide")} sub={t("controlAdmin:deviceSync.guideSub")} href="/help/phone-sync-setup" />
            </GroupedList>
          </aside>
        </div>
      </div>

      {/* ?show=address: the address phones use, a popup over the page. */}
      {show.page === "address" && (
        <AddressDialog
          errors={errors}
          busy={busy}
          view={networks}
          onClose={() => go({ page: "list" })}
          onSave={(address) => act(() => api("/api/photo-sync/address", { method: "PUT", body: JSON.stringify({ address }) }), { page: "list" })}
        />
      )}

      {/* ?show=add-network: the popup over the page (old links land here too). */}
      {show.page === "addNetwork" && (
        <AddNetworkDialog
          errors={errors}
          busy={busy}
          onClose={() => go({ page: "list" })}
          onAdd={(cidr, label) => act(() => api("/api/photo-sync/networks", { method: "POST", body: JSON.stringify({ cidr, label: label || undefined }) }), { page: "list" })}
          onCopy={() => act(() => api("/api/photo-sync/networks/copy-trusted", { method: "POST" }), { page: "list" })}
        />
      )}
    </>
  );
}

/** Add a phone-backup network: a popup over Device Sync (owner, 2026-11-16) — the
 *  range and an optional name, or every trusted sign-in network at once. */
function AddNetworkDialog({ errors, busy, onAdd, onCopy, onClose }: {
  errors: React.ReactNode;
  busy: boolean;
  onAdd: (cidr: string, label: string) => Promise<unknown>;
  onCopy: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["controlAdmin", "control", "common"]);
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cidr.trim()) void onAdd(cidr.trim(), label.trim());
  };
  return (
    <Modal title={t("controlAdmin:phoneSync.add")} busy={busy} onClose={onClose} onSubmit={submit}>
      <p className="muted">{t("controlAdmin:deviceSync.addNote")}</p>
      {errors}
      <Field label={t("controlAdmin:security.cidrLabel")} value={cidr} onChange={setCidr} placeholder="192.168.2.0/24" />
      <Field label={t("controlAdmin:security.labelOptional")} value={label} onChange={setLabel} placeholder={t("controlAdmin:phoneSync.labelPlaceholder")} required={false} />
      <Button variant="text" compact className="device-sync-copy" disabled={busy} onClick={() => void onCopy()}>
        {busy ? t("controlAdmin:phoneSync.copying") : t("controlAdmin:phoneSync.copyTrusted")}
      </Button>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !cidr.trim()}>
          {busy ? t("controlAdmin:security.adding") : t("controlAdmin:phoneSync.add")}
        </Button>
      </div>
    </Modal>
  );
}

/** The address phones use: a popup over Device Sync (owner, 2026-11-16) — the URL,
 *  a warning while it is outside the allowed networks, Save, and Clear. */
function AddressDialog({ errors, busy, view, onSave, onClose }: {
  errors: React.ReactNode;
  busy: boolean;
  view: NetworksView;
  onSave: (address: string | null) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["controlAdmin", "control", "common"]);
  const [address, setAddress] = useState(view.address ?? "");
  // The server validates it properly; this only keeps Save off for an obvious non-URL.
  const valid = /^https?:\/\//i.test(address.trim());
  return (
    <Modal
      title={t("controlAdmin:phoneSync.addressHeading")}
      busy={busy}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); if (valid) void onSave(address.trim()); }}
    >
      <p className="muted">{t("controlAdmin:phoneSync.addressDesc")}</p>
      {errors}
      {view.address && view.addressOutsideNetworks && (
        <MessageBox tone="warning" title={t("controlAdmin:phoneSync.outsideTitle")}>{t("controlAdmin:phoneSync.outsideBody")}</MessageBox>
      )}
      <Field label={t("controlAdmin:phoneSync.addressLabel")} value={address} onChange={setAddress} placeholder="http://192.168.2.10:4000" required={false} />
      <div className="modal-actions">
        {view.address && (
          <Button variant="secondary" danger className="modal-actions-start" disabled={busy} onClick={() => void onSave(null)}>
            {t("controlAdmin:phoneSync.clearAddress")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !valid}>
          {busy ? t("controlAdmin:phoneSync.saving") : t("controlAdmin:phoneSync.saveAddress")}
        </Button>
      </div>
    </Modal>
  );
}
