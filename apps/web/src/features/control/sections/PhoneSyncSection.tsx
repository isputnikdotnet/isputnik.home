import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Layers, Link2, Plus, ScrollText, Smartphone, Wifi } from "lucide-react";
import { api } from "../../../api";
import { libraryManageHref, memberHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { ActionRow, AddRow, FieldRow, GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { relativeTime } from "../../../shared/relativeTime";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";
import { logsHref } from "../links";
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
  | { page: "personal" };

function readShow(): Show {
  const value = new URLSearchParams(window.location.search).get("show") ?? "";
  if (value.startsWith("phone:")) return { page: "phone", id: value.slice(6) };
  if (value.startsWith("network:")) return { page: "network", id: value.slice(8) };
  if (value === "add-network") return { page: "addNetwork" };
  if (value === "address") return { page: "address" };
  if (value === "personal") return { page: "personal" };
  return { page: "list" };
}

function showParam(show: Show): string | null {
  switch (show.page) {
    case "phone": return `phone:${show.id}`;
    case "network": return `network:${show.id}`;
    case "addNetwork": return "add-network";
    case "address": return "address";
    case "personal": return "personal";
    default: return null;
  }
}

/** A step into a page is a history entry, so the browser's Back returns to the list. */
function useShow(): [Show, (next: Show) => void] {
  const [show, setShow] = useState<Show>(readShow);
  useEffect(() => {
    const onPop = () => setShow(readShow());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: Show) => {
    const query = new URLSearchParams(window.location.search);
    const param = showParam(next);
    if (param) query.set("show", param);
    else query.delete("show");
    window.history.pushState(window.history.state, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
    setShow(next);
    window.scrollTo({ top: 0 });
  }, []);
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

  // The personal-library editor picks its folder from the library locations.
  useEffect(() => {
    if (show.page !== "personal" || storageRoots) return;
    api<{ roots: StorageRoot[] }>("/api/storage/roots")
      .then((payload) => setStorageRoots(payload.roots))
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed")));
  }, [show.page, storageRoots, t]);

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
    <a
      className="text-button control-page-back"
      href={window.location.pathname}
      onClick={(event) => { event.preventDefault(); go({ page: "list" }); }}
    >
      <ArrowLeft size={15} aria-hidden="true" />
      {t("control:nav.tabs.phoneSync")}
    </a>
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
    if (!phone) return <>{head}{backToList}<p className="access-muted">{t("controlAdmin:deviceSync.gone")}</p></>;
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
          {phone.links.map((link) => (
            <NavRow
              key={link.libraryId}
              icon={<BookOpen size={17} />}
              label={link.name}
              sub={link.counts ? undefined : t("controlAdmin:deviceSync.linkNoAccess")}
              href={libraryManageHref(link.libraryId)}
            />
          ))}
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
    if (!network) return <>{head}{backToList}<p className="access-muted">{t("controlAdmin:deviceSync.gone")}</p></>;
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

  // ── Add a network ──────────────────────────────────────────────────────────
  if (show.page === "addNetwork") {
    return <AddNetworkPage back={backToList} errors={errors} busy={busy} onAdd={(cidr, label) => act(() => api("/api/photo-sync/networks", { method: "POST", body: JSON.stringify({ cidr, label: label || undefined }) }), { page: "list" })} onCopy={() => act(() => api("/api/photo-sync/networks/copy-trusted", { method: "POST" }), { page: "list" })} />;
  }

  // ── The address phones use ─────────────────────────────────────────────────
  if (show.page === "address") {
    return (
      <AddressPage
        back={backToList}
        errors={errors}
        busy={busy}
        view={networks}
        onSave={(address) => act(() => api("/api/photo-sync/address", { method: "PUT", body: JSON.stringify({ address }) }), { page: "list" })}
      />
    );
  }

  // ── Personal libraries ─────────────────────────────────────────────────────
  if (show.page === "personal") {
    return (
      <div className="device-sync device-sync-wide">
        {backToList}
        {errors}
        {storageRoots ? <PersonalLibrariesPanel storageRoots={storageRoots} /> : <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
      </div>
    );
  }

  // ── The list ───────────────────────────────────────────────────────────────
  const lastBackup = phones.map((phone) => phone.lastSeen).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  return (
    <>
      {head}
      <div className="device-sync">
        {errors}
        {on ? (
          <GroupedList>
            <InfoRow
              icon={<Smartphone size={17} />}
              iconTone="ok"
              label={t("controlAdmin:deviceSync.statusOn")}
              sub={lastBackup
                ? t("controlAdmin:deviceSync.statusOnSub", { count: phones.length, when: relativeTime(lastBackup) })
                : t("controlAdmin:deviceSync.statusOnNoBackup", { count: phones.length })}
            />
          </GroupedList>
        ) : (
          <GroupedList title={t("controlAdmin:deviceSync.setupTitle")} note={t("controlAdmin:deviceSync.setupNote")}>
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
        )}

        <GroupedList title={t("controlAdmin:phoneSyncPage.phonesHeading")} note={phones.length === 0 ? t("controlAdmin:phoneSyncPage.noPhones") : undefined}>
          {phones.length === 0 && <InfoRow icon={<Smartphone size={17} />} label={t("controlAdmin:deviceSync.noPhonesRow")} />}
          {phones.map((phone) => {
            const state = shortState(phone);
            return (
              <NavRow
                key={phone.id}
                icon={<Smartphone size={17} />}
                iconTone={state.warn ? "warn" : undefined}
                label={phoneName(phone)}
                sub={phone.member.name}
                value={state.text}
                valueTone={state.warn ? "warn" : undefined}
                onClick={() => go({ page: "phone", id: phone.id })}
              />
            );
          })}
        </GroupedList>

        <GroupedList title={t("controlAdmin:deviceSync.networksTitle")} note={t("controlAdmin:deviceSync.networksNote")}>
          {networks.networks.map((network) => (
            <NavRow
              key={network.id}
              icon={<Wifi size={17} />}
              label={network.label || network.cidr}
              value={network.label ? network.cidr : undefined}
              onClick={() => go({ page: "network", id: network.id })}
            />
          ))}
          <AddRow icon={<Plus size={17} />} label={t("controlAdmin:phoneSync.add")} onClick={() => go({ page: "addNetwork" })} />
        </GroupedList>

        <GroupedList title={t("controlAdmin:phoneSync.addressHeading")} note={t("controlAdmin:deviceSync.addressNote")}>
          <NavRow
            icon={<Link2 size={17} />}
            iconTone={networks.address && networks.addressOutsideNetworks ? "warn" : undefined}
            label={networks.address ?? t("controlAdmin:deviceSync.notSet")}
            sub={networks.address && networks.addressOutsideNetworks ? t("controlAdmin:phoneSync.outsideTitle") : undefined}
            onClick={() => go({ page: "address" })}
          />
        </GroupedList>

        <GroupedList title={t("controlAdmin:deviceSync.personalTitle")}>
          <NavRow
            icon={<Layers size={17} />}
            label={t("controlAdmin:deviceSync.personalRow")}
            value={personal ? (personal.settings.enabled ? t("controlAdmin:deviceSync.on") : t("controlAdmin:deviceSync.off")) : "…"}
            valueTone={personal?.settings.enabled ? "ok" : undefined}
            onClick={() => go({ page: "personal" })}
          />
          {(personal?.libraries ?? []).map((library) => (
            <NavRow
              key={library.id}
              icon={<BookOpen size={17} />}
              label={library.name}
              sub={library.ownerName}
              value={formatBytes(library.sizeBytes)}
              href={libraryManageHref(library.id)}
            />
          ))}
        </GroupedList>

        <GroupedList>
          <NavRow icon={<ScrollText size={17} />} label={t("controlAdmin:phoneSyncPage.allInLogs")} value={t("controlAdmin:deviceSync.logs")} href={logsHref({ event: "photo_sync" })} />
        </GroupedList>
      </div>
    </>
  );
}

function AddNetworkPage({ back, errors, busy, onAdd, onCopy }: {
  back: React.ReactNode;
  errors: React.ReactNode;
  busy: boolean;
  onAdd: (cidr: string, label: string) => Promise<unknown>;
  onCopy: () => Promise<unknown>;
}) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cidr.trim()) void onAdd(cidr.trim(), label.trim());
  };
  return (
    <form className="device-sync" onSubmit={submit}>
      {back}
      <div className="device-sync-title"><h1>{t("controlAdmin:phoneSync.add")}</h1></div>
      {errors}
      <GroupedList note={t("controlAdmin:deviceSync.addNote")}>
        <FieldRow><Field label={t("controlAdmin:security.cidrLabel")} value={cidr} onChange={setCidr} placeholder="192.168.2.0/24" /></FieldRow>
        <FieldRow><Field label={t("controlAdmin:security.labelOptional")} value={label} onChange={setLabel} placeholder={t("controlAdmin:phoneSync.labelPlaceholder")} required={false} /></FieldRow>
      </GroupedList>
      <GroupedList>
        <Button variant="bare" type="submit" className="grouped-row grouped-row-action is-accent" disabled={busy || !cidr.trim()}>
          {busy ? t("controlAdmin:security.adding") : t("controlAdmin:phoneSync.add")}
        </Button>
        <ActionRow label={busy ? t("controlAdmin:phoneSync.copying") : t("controlAdmin:phoneSync.copyTrusted")} disabled={busy} onClick={() => void onCopy()} />
      </GroupedList>
    </form>
  );
}

function AddressPage({ back, errors, busy, view, onSave }: {
  back: React.ReactNode;
  errors: React.ReactNode;
  busy: boolean;
  view: NetworksView;
  onSave: (address: string | null) => Promise<unknown>;
}) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [address, setAddress] = useState(view.address ?? "");
  // The server validates it properly; this only keeps Save off for an obvious non-URL.
  const valid = /^https?:\/\//i.test(address.trim());
  return (
    <form className="device-sync" onSubmit={(event) => { event.preventDefault(); if (valid) void onSave(address.trim()); }}>
      {back}
      <div className="device-sync-title"><h1>{t("controlAdmin:phoneSync.addressHeading")}</h1></div>
      {errors}
      {view.address && view.addressOutsideNetworks && (
        <MessageBox tone="warning" title={t("controlAdmin:phoneSync.outsideTitle")}>{t("controlAdmin:phoneSync.outsideBody")}</MessageBox>
      )}
      <GroupedList note={t("controlAdmin:phoneSync.addressDesc")}>
        <FieldRow><Field label={t("controlAdmin:phoneSync.addressLabel")} value={address} onChange={setAddress} placeholder="http://192.168.2.10:4000" required={false} /></FieldRow>
      </GroupedList>
      <GroupedList>
        <Button variant="bare" type="submit" className="grouped-row grouped-row-action is-accent" disabled={busy || !valid}>
          {busy ? t("controlAdmin:phoneSync.saving") : t("controlAdmin:phoneSync.saveAddress")}
        </Button>
        {view.address && <ActionRow tone="danger" label={t("controlAdmin:phoneSync.clearAddress")} disabled={busy} onClick={() => void onSave(null)} />}
      </GroupedList>
    </form>
  );
}
