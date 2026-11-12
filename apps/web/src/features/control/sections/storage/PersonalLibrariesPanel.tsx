import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, UserRoundCheck } from "lucide-react";
import { api } from "../../../../api";
import { libraryManageHref } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { formatDate } from "../../../../shared/dates";
import { ActionRow, AddRow, CheckRow, FieldRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../../../../shared/GroupedList";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { SelectField } from "../../../../shared/SelectField";
import { formatBytes } from "../../../../shared/utils";
import type { StorageRoot } from "../../types";

type Subject = { type: "user" | "group"; id: string };

interface PersonalSettings {
  enabled: boolean;
  storageRootId: string | null;
  folder: string;
  who: "everyone" | "chosen";
  subjects: Subject[];
  sizeLimitGB: number | null;
}

interface PersonalLibraryRow {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  orphanedAt: string | null;
  adoptedAt: string | null;
  createdAt: string;
  sizeBytes: number;
  /** Phones backing up into it — a count only. */
  phones: number;
}

interface AdminView {
  settings: PersonalSettings;
  parentFolder: string | null;
  libraries: PersonalLibraryRow[];
}

interface Member { id: string; displayName: string; isActive?: boolean }
interface Group { id: string; name: string }
interface GalleryLibraryOption { id: string; name: string; role: string | null; personal: unknown }

type Pending =
  | { kind: "adopt"; libraryId: string; userId: string }
  | { kind: "handOver"; library: PersonalLibraryRow; userId: string }
  | { kind: "delete"; library: PersonalLibraryRow };

/** The size limits offered as one tap; anything else is typed under them. */
const LIMIT_CHOICES = [25, 50, 100, 250];

// Applications › Gallery › Device Sync › Personal libraries (docs/photo-sync-plan.md,
// phase 1, decision 4 and open questions 6–8): whether members may have a private
// library of their own, who, where they are made and how big they may grow — and
// the libraries there are, as whose they are and their size. Never what is in them:
// an admin cannot open someone else's personal library.
//
// Laid out like a phone's Settings (shared/GroupedList), as Device Sync is: a switch,
// ticked choices, and each change saved the moment it is made — no Save button. The
// two typed values (the folder, a size limit not on the list) save when you leave the
// field or press Enter. Choosing a member to hand a library to stays a dialog.
export function PersonalLibrariesPanel({ storageRoots }: { storageRoots: StorageRoot[] }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<AdminView | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [galleries, setGalleries] = useState<GalleryLibraryOption[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  const [folderText, setFolderText] = useState("");
  const [limitText, setLimitText] = useState("");

  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptLibrary, setAdoptLibrary] = useState("");
  const [adoptMember, setAdoptMember] = useState("");
  const [handOver, setHandOver] = useState<PersonalLibraryRow | null>(null);
  const [handOverMember, setHandOverMember] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");

  const apply = useCallback((next: AdminView) => {
    setView(next);
    setFolderText(next.settings.folder);
    const limit = next.settings.sizeLimitGB;
    setLimitText(limit != null && !LIMIT_CHOICES.includes(limit) ? String(limit) : "");
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api<AdminView>("/api/storage/personal-libraries"));
      const [users, groupList, libraries] = await Promise.all([
        api<{ users: Member[] }>("/api/users"),
        api<{ groups: Group[] }>("/api/groups"),
        api<{ libraries: GalleryLibraryOption[] }>("/api/library/gallery-libraries?manage=1")
      ]);
      setMembers(users.users.filter((user) => user.isActive !== false));
      setGroups(groupList.groups);
      setGalleries(libraries.libraries);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:personalLibraries.loadFailed"));
    }
  }, [apply, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  const owners = useMemo(() => new Set((view?.libraries ?? []).filter((l) => !l.orphanedAt).map((l) => l.ownerId)), [view]);
  const membersWithout = members.filter((member) => !owners.has(member.id));
  const adoptable = galleries.filter((library) => !library.role && !library.personal);
  const memberName = (id: string) => members.find((m) => m.id === id)?.displayName ?? "";
  const libraryName = (id: string) => galleries.find((l) => l.id === id)?.name ?? "";

  if (!view) {
    return error ? <MessageBox tone="error" title={t("controlAdmin:personalLibraries.errorTitle")}>{error}</MessageBox> : null;
  }
  const settings = view.settings;

  /** One change, applied at once and saved; put back if the save fails. */
  const save = async (patch: Partial<PersonalSettings>) => {
    const before = view;
    const next = { ...settings, ...patch };
    setView({ ...view, settings: next });
    setSaving(true);
    setError("");
    try {
      apply(await api<AdminView>("/api/storage/personal-libraries/settings", { method: "PUT", body: JSON.stringify(next) }));
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      apply(before);
      setError(err instanceof Error ? err.message : t("controlAdmin:personalLibraries.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const hasSubject = (subject: Subject) => settings.subjects.some((s) => s.type === subject.type && s.id === subject.id);
  const toggleSubject = (subject: Subject, on: boolean) => void save({
    subjects: on ? [...settings.subjects, subject] : settings.subjects.filter((s) => !(s.type === subject.type && s.id === subject.id))
  });

  const saveFolder = () => {
    if (folderText.trim() && folderText.trim() !== settings.folder) void save({ folder: folderText.trim() });
  };
  const saveCustomLimit = () => {
    const text = limitText.trim();
    if (text === "") return;
    const limit = Number(text.replace(",", "."));
    if (!Number.isFinite(limit) || limit <= 0) {
      setError(t("controlAdmin:personalLibraries.badLimit"));
      return;
    }
    if (limit !== settings.sizeLimitGB) void save({ sizeLimitGB: limit });
  };

  async function confirmPending() {
    if (!pending) return;
    setActing(true);
    setActionError("");
    try {
      if (pending.kind === "adopt") {
        apply(await api<AdminView>("/api/storage/personal-libraries/adopt", {
          method: "POST",
          body: JSON.stringify({ libraryId: pending.libraryId, userId: pending.userId })
        }));
        setGalleries((list) => list.map((l) => (l.id === pending.libraryId ? { ...l, personal: true } : l)));
      } else if (pending.kind === "handOver") {
        apply(await api<AdminView>(`/api/storage/personal-libraries/${encodeURIComponent(pending.library.id)}/hand-over`, {
          method: "POST",
          body: JSON.stringify({ userId: pending.userId })
        }));
      } else {
        await api(`/api/library/gallery-libraries/${encodeURIComponent(pending.library.id)}`, { method: "DELETE" });
        apply(await api<AdminView>("/api/storage/personal-libraries"));
      }
      setPending(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("controlAdmin:personalLibraries.actionFailed"));
    } finally {
      setActing(false);
    }
  }

  const customLimit = settings.sizeLimitGB != null && !LIMIT_CHOICES.includes(settings.sizeLimitGB);
  const inUse = view.libraries.filter((library) => !library.orphanedAt);
  const ownerless = view.libraries.filter((library) => library.orphanedAt);
  const totals = view.libraries.length > 0
    ? t("controlAdmin:personalLibraries.totals", {
      libraries: t("controlAdmin:personalLibraries.librariesCount", { count: view.libraries.length }),
      size: formatBytes(view.libraries.reduce((sum, library) => sum + library.sizeBytes, 0)),
      phones: t("controlAdmin:personalLibraries.phonesCount", { count: view.libraries.reduce((sum, library) => sum + library.phones, 0) })
    })
    : undefined;

  return (
    <div id="personal-libraries" className="device-sync">
      <div className="device-sync-title">
        <h1>{t("controlAdmin:personalLibraries.title")}</h1>
        {saved && <span className="app-status-pill is-ready">{t("controlAdmin:personalLibraries.saved")}</span>}
      </div>
      <p className="muted">{t("controlAdmin:personalLibraries.description")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:personalLibraries.saveFailed")}>{error}</MessageBox>}

      <GroupedList>
        <ToggleRow label={t("controlAdmin:personalLibraries.enabled")} checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
      </GroupedList>

      {settings.enabled && (
        <>
          <GroupedList title={t("controlAdmin:personalLibraries.who")}>
            <CheckRow label={t("controlAdmin:personalLibraries.whoEveryone")} checked={settings.who === "everyone"} disabled={saving} onSelect={() => void save({ who: "everyone" })} />
            <CheckRow label={t("controlAdmin:personalLibraries.whoChosen")} checked={settings.who === "chosen"} disabled={saving} onSelect={() => void save({ who: "chosen" })} />
          </GroupedList>

          {settings.who === "chosen" && (
            <GroupedList title={t("controlAdmin:personalLibraries.chosenTitle")}>
              {groups.map((group) => (
                <ToggleRow
                  key={`g-${group.id}`}
                  label={t("controlAdmin:personalLibraries.groupLabel", { name: group.name })}
                  checked={hasSubject({ type: "group", id: group.id })}
                  disabled={saving}
                  onChange={(on) => toggleSubject({ type: "group", id: group.id }, on)}
                />
              ))}
              {members.map((member) => (
                <ToggleRow
                  key={`u-${member.id}`}
                  label={member.displayName}
                  checked={hasSubject({ type: "user", id: member.id })}
                  disabled={saving}
                  onChange={(on) => toggleSubject({ type: "user", id: member.id }, on)}
                />
              ))}
            </GroupedList>
          )}

          <GroupedList
            title={t("controlAdmin:personalLibraries.root")}
            note={view.parentFolder ? t("controlAdmin:personalLibraries.createdIn", { path: view.parentFolder }) : undefined}
          >
            {storageRoots.length === 0 && <InfoRow label={t("controlAdmin:personalLibraries.noRoot")} />}
            {storageRoots.map((root) => (
              <CheckRow
                key={root.id}
                label={root.name}
                sub={root.path}
                checked={settings.storageRootId === root.id}
                disabled={saving}
                onSelect={() => void save({ storageRootId: root.id })}
              />
            ))}
            <FieldRow>
              <label className="grouped-field">
                <span>{t("controlAdmin:personalLibraries.folder")}</span>
                <input value={folderText} onChange={(event) => setFolderText(event.target.value)} onBlur={saveFolder} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveFolder(); } }} />
              </label>
            </FieldRow>
          </GroupedList>

          <GroupedList title={t("controlAdmin:personalLibraries.limitTitle")} note={t("controlAdmin:personalLibraries.limitNote")}>
            <CheckRow label={t("controlAdmin:personalLibraries.limitPlaceholder")} checked={settings.sizeLimitGB == null} disabled={saving} onSelect={() => void save({ sizeLimitGB: null })} />
            {LIMIT_CHOICES.map((limit) => (
              <CheckRow
                key={limit}
                label={t("controlAdmin:personalLibraries.limitEach", { size: limit })}
                checked={settings.sizeLimitGB === limit}
                disabled={saving}
                onSelect={() => void save({ sizeLimitGB: limit })}
              />
            ))}
            <FieldRow>
              <label className={`grouped-field${customLimit ? " is-chosen" : ""}`}>
                <span>{t("controlAdmin:personalLibraries.limitOther")}</span>
                <input
                  inputMode="decimal"
                  value={limitText}
                  placeholder={t("controlAdmin:personalLibraries.limitOtherPlaceholder")}
                  onChange={(event) => setLimitText(event.target.value)}
                  onBlur={saveCustomLimit}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveCustomLimit(); } }}
                />
              </label>
            </FieldRow>
          </GroupedList>
        </>
      )}

      <GroupedList title={t("controlAdmin:personalLibraries.listTitle")} note={[totals, t("controlAdmin:personalLibraries.listNote")].filter(Boolean).join(" · ")}>
        {view.libraries.length === 0 && <InfoRow icon={<BookOpen size={17} />} label={t("controlAdmin:personalLibraries.none")} />}
        {inUse.map((library) => (
          <NavRow
            key={library.id}
            icon={<BookOpen size={17} />}
            label={t("controlAdmin:personalLibraries.whose", { name: library.ownerName })}
            sub={library.adoptedAt ? t("controlAdmin:personalLibraries.adoptedOn", { date: formatDate(library.adoptedAt) }) : t("controlAdmin:personalLibraries.phonesCount", { count: library.phones })}
            value={formatBytes(library.sizeBytes)}
            href={libraryManageHref(library.id)}
          />
        ))}
        <AddRow
          icon={<UserRoundCheck size={17} />}
          label={t("controlAdmin:personalLibraries.adopt")}
          onClick={() => { setAdoptLibrary(""); setAdoptMember(""); setActionError(""); setAdoptOpen(true); }}
        />
      </GroupedList>

      {ownerless.map((library) => (
        <GroupedList key={library.id} title={t("controlAdmin:personalLibraries.ownerlessTitle")}>
          <InfoRow
            icon={<BookOpen size={17} />}
            iconTone="warn"
            label={t("controlAdmin:personalLibraries.whose", { name: library.ownerName })}
            sub={t("controlAdmin:personalLibraries.orphanedOn", { date: formatDate(library.orphanedAt ?? library.createdAt) })}
            value={formatBytes(library.sizeBytes)}
          />
          <ActionRow label={t("controlAdmin:personalLibraries.handOverRow")} onClick={() => { setHandOverMember(""); setActionError(""); setHandOver(library); }} />
          <ActionRow tone="danger" label={t("controlAdmin:personalLibraries.deleteRow")} onClick={() => { setActionError(""); setPending({ kind: "delete", library }); }} />
        </GroupedList>
      ))}

      {adoptOpen && (
        <Modal
          title={t("controlAdmin:personalLibraries.adoptTitle")}
          onClose={() => setAdoptOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!adoptLibrary || !adoptMember) return;
            setAdoptOpen(false);
            setPending({ kind: "adopt", libraryId: adoptLibrary, userId: adoptMember });
          }}
        >
          <p>{t("controlAdmin:personalLibraries.adoptIntro")}</p>
          <SelectField
            label={t("controlAdmin:personalLibraries.adoptLibrary")}
            value={adoptLibrary}
            options={[{ value: "", label: t("controlAdmin:personalLibraries.choose") }, ...adoptable.map((l) => ({ value: l.id, label: l.name }))]}
            onChange={setAdoptLibrary}
          />
          <SelectField
            label={t("controlAdmin:personalLibraries.adoptMember")}
            value={adoptMember}
            options={[{ value: "", label: t("controlAdmin:personalLibraries.choose") }, ...membersWithout.map((m) => ({ value: m.id, label: m.displayName }))]}
            onChange={setAdoptMember}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setAdoptOpen(false)} autoFocus>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={!adoptLibrary || !adoptMember}>{t("controlAdmin:personalLibraries.continue")}</Button>
          </div>
        </Modal>
      )}

      {handOver && (
        <Modal
          title={t("controlAdmin:personalLibraries.handOverTitle", { name: handOver.ownerName })}
          onClose={() => setHandOver(null)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!handOverMember) return;
            setPending({ kind: "handOver", library: handOver, userId: handOverMember });
            setHandOver(null);
          }}
        >
          <p>{t("controlAdmin:personalLibraries.handOverIntro")}</p>
          <SelectField
            label={t("controlAdmin:personalLibraries.adoptMember")}
            value={handOverMember}
            options={[{ value: "", label: t("controlAdmin:personalLibraries.choose") }, ...membersWithout.map((m) => ({ value: m.id, label: m.displayName }))]}
            onChange={setHandOverMember}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setHandOver(null)} autoFocus>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={!handOverMember}>{t("controlAdmin:personalLibraries.continue")}</Button>
          </div>
        </Modal>
      )}

      {pending?.kind === "adopt" && (
        <ConfirmDialog
          title={t("controlAdmin:personalLibraries.confirmAdoptTitle", { library: libraryName(pending.libraryId), name: memberName(pending.userId) })}
          confirmLabel={t("controlAdmin:personalLibraries.confirmAdopt")}
          busyLabel={t("controlAdmin:personalLibraries.adopting")}
          busy={acting}
          danger
          error={actionError}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        >
          <p>{t("controlAdmin:personalLibraries.confirmAdoptBody", { name: memberName(pending.userId) })}</p>
          <p>{t("controlAdmin:personalLibraries.confirmAdoptKept")}</p>
        </ConfirmDialog>
      )}
      {pending?.kind === "handOver" && (
        <ConfirmDialog
          title={t("controlAdmin:personalLibraries.confirmHandOverTitle", { from: pending.library.ownerName, name: memberName(pending.userId) })}
          confirmLabel={t("controlAdmin:personalLibraries.confirmHandOver")}
          busyLabel={t("controlAdmin:personalLibraries.handingOver")}
          busy={acting}
          error={actionError}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        >
          <p>{t("controlAdmin:personalLibraries.confirmHandOverBody", { name: memberName(pending.userId) })}</p>
        </ConfirmDialog>
      )}
      {pending?.kind === "delete" && (
        <ConfirmDialog
          title={t("controlAdmin:personalLibraries.confirmDeleteTitle", { name: pending.library.ownerName })}
          confirmLabel={t("controlAdmin:personalLibraries.confirmDelete")}
          busyLabel={t("controlAdmin:personalLibraries.deleting")}
          busy={acting}
          danger
          error={actionError}
          onConfirm={() => void confirmPending()}
          onCancel={() => setPending(null)}
        >
          <p>{t("controlAdmin:personalLibraries.confirmDeleteBody", { size: formatBytes(pending.library.sizeBytes) })}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
