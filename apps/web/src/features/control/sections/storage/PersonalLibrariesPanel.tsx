import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FolderOpen, Gauge, UserRoundCheck, Users } from "lucide-react";
import { api } from "../../../../api";
import { libraryManageHref } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl } from "../../../../shared/AccessControl";
import { AccessDialog } from "../../../../shared/AccessDialog";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { formatDate } from "../../../../shared/dates";
import { ActionRow, AddRow, CheckRow, CommandRow, FieldRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../../../../shared/GroupedList";
import { Field } from "../../../../shared/Field";
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
interface GalleryLibraryOption { id: string; name: string; role: string | null; personal: unknown; canManageLibrary?: boolean }

type Pending =
  | { kind: "adopt"; libraryId: string; userId: string }
  | { kind: "handOver"; library: PersonalLibraryRow; userId: string }
  | { kind: "delete"; library: PersonalLibraryRow };

const BACKSLASH = String.fromCharCode(92);

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
//
// Device Sync shows it in two places (owner, 2026-11-16): the settings in its main
// column (`part="settings"`) and the libraries in its right column
// (`part="libraries"`); `part="all"` is the whole panel on a page of its own.
// `part="actions"` is Device Sync's "Make a library personal" page: the choice of
// library and member in the page, and the ownerless libraries to hand over or delete.
export function PersonalLibrariesPanel({ storageRoots, part = "all", onChanged }: {
  storageRoots: StorageRoot[];
  part?: "all" | "settings" | "libraries" | "actions";
  /** After a change is saved — so a page's counts can be read again. */
  onChanged?: () => void;
}) {
  const showSettings = part === "all" || part === "settings";
  const showList = part !== "settings";
  const listRows = part !== "actions";
  const standalone = part === "all";
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

  const [whereOpen, setWhereOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const [whereRoot, setWhereRoot] = useState("");
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
  const save = async (patch: Partial<PersonalSettings>): Promise<boolean> => {
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
      onChanged?.();
      return true;
    } catch (err) {
      apply(before);
      setError(err instanceof Error ? err.message : t("controlAdmin:personalLibraries.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleSubject = (subject: Subject, on: boolean) => void save({
    subjects: on ? [...settings.subjects, subject] : settings.subjects.filter((s) => !(s.type === subject.type && s.id === subject.id))
  });

  const currentRoot = storageRoots.find((root) => root.id === settings.storageRootId) ?? null;
  // Who may have one, in a line: everyone, or the first few chosen and how many more.
  const chosenNames = settings.subjects.map((subject) => subject.type === "group"
    ? t("controlAdmin:personalLibraries.groupLabel", { name: groups.find((g) => g.id === subject.id)?.name ?? "" })
    : memberName(subject.id)).filter(Boolean);
  const whoSummary = settings.who === "everyone"
    ? t("controlAdmin:personalLibraries.whoEveryone")
    : chosenNames.length === 0
      ? t("controlAdmin:personalLibraries.whoNone")
      : chosenNames.length <= 3
        ? chosenNames.join(", ")
        : t("controlAdmin:personalLibraries.whoMore", { names: chosenNames.slice(0, 3).join(", "), count: chosenNames.length - 3 });
  // The folder the dialog would make, spelled the way the location is (Windows or not).
  const chosenRoot = storageRoots.find((root) => root.id === whereRoot) ?? null;
  const sep = chosenRoot?.path.includes(BACKSLASH) ? BACKSLASH : "/";
  const previewPath = chosenRoot && folderText.trim()
    ? [chosenRoot.path.replace(/[\\/]+$/, ""), ...folderText.trim().split(/[\\/]+/).filter(Boolean)].join(sep)
    : null;
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
      setAdoptLibrary("");
      setAdoptMember("");
      onChanged?.();
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
    <div id={showSettings ? "personal-libraries" : undefined} className="device-sync">
      {standalone && (
        <>
          <div className="device-sync-title">
            <h1>{t("controlAdmin:personalLibraries.title")}</h1>
            {saved && <span className="app-status-pill is-ready">{t("controlAdmin:personalLibraries.saved")}</span>}
          </div>
          <p className="muted">{t("controlAdmin:personalLibraries.description")}</p>
        </>
      )}
      {error && <MessageBox tone="error" title={t("controlAdmin:personalLibraries.saveFailed")}>{error}</MessageBox>}

      {/* The switch, then — while it is on — the two things it needs, each ONE row
          saying what it is set to, with Change (a standard compact button) opening a
          dialog: where they are made (a location and a folder name, the path shown
          before saving) and who may have one. */}
      {showSettings && (
      <GroupedList
        title={standalone ? undefined : t("controlAdmin:personalLibraries.title")}
        note={settings.enabled ? t("controlAdmin:personalLibraries.whereNote") : t("controlAdmin:personalLibraries.offNote")}
      >
        <ToggleRow label={t("controlAdmin:personalLibraries.enabled")} checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
        {settings.enabled && (
          <>
            <CommandRow
              icon={<FolderOpen size={17} />}
              label={t("controlAdmin:personalLibraries.locationLabel")}
              sub={view.parentFolder
                ? <><code>{view.parentFolder}</code>{currentRoot && <> · {t("controlAdmin:personalLibraries.whereInside", { root: currentRoot.name })}</>}</>
                : t("controlAdmin:personalLibraries.notChosen")}
              value={t("controlAdmin:personalLibraries.change")}
              disabled={saving}
              onClick={() => { setWhereRoot(settings.storageRootId ?? storageRoots[0]?.id ?? ""); setFolderText(settings.folder); setWhereOpen(true); }}
            />
            <CommandRow
              icon={<Users size={17} />}
              label={t("controlAdmin:personalLibraries.who")}
              sub={whoSummary}
              value={t("controlAdmin:personalLibraries.change")}
              disabled={saving}
              onClick={() => setWhoOpen(true)}
            />
            <CommandRow
              icon={<Gauge size={17} />}
              label={t("controlAdmin:personalLibraries.limitTitle")}
              sub={settings.sizeLimitGB == null
                ? t("controlAdmin:personalLibraries.limitPlaceholder")
                : t("controlAdmin:personalLibraries.limitEach", { size: settings.sizeLimitGB })}
              value={t("controlAdmin:personalLibraries.change")}
              disabled={saving}
              onClick={() => setLimitOpen(true)}
            />
          </>
        )}
      </GroupedList>
      )}

      {showList && (
      <>
      {/* A page of its own (Device Sync › Make a library personal): the choice in the
          page, not in a dialog — which gallery library, whose — then the confirmation
          that says what changes. */}
      {!listRows ? (
        <>
          <GroupedList title={t("controlAdmin:personalLibraries.adoptTitle")} note={t("controlAdmin:personalLibraries.adoptIntro")}>
            <FieldRow>
              <SelectField
                label={t("controlAdmin:personalLibraries.adoptLibrary")}
                value={adoptLibrary}
                options={[{ value: "", label: adoptable.length ? t("controlAdmin:personalLibraries.choose") : t("controlAdmin:personalLibraries.noAdoptable") }, ...adoptable.map((l) => ({ value: l.id, label: l.name }))]}
                onChange={setAdoptLibrary}
              />
            </FieldRow>
            <FieldRow>
              <SelectField
                label={t("controlAdmin:personalLibraries.adoptMember")}
                value={adoptMember}
                options={[{ value: "", label: membersWithout.length ? t("controlAdmin:personalLibraries.choose") : t("controlAdmin:personalLibraries.noMemberWithout") }, ...membersWithout.map((m) => ({ value: m.id, label: m.displayName }))]}
                onChange={setAdoptMember}
              />
            </FieldRow>
          </GroupedList>
          <div className="device-sync-actions">
            <Button
              variant="primary"
              disabled={!adoptLibrary || !adoptMember}
              onClick={() => { setActionError(""); setPending({ kind: "adopt", libraryId: adoptLibrary, userId: adoptMember }); }}
            >
              {t("controlAdmin:personalLibraries.confirmAdopt")}
            </Button>
          </div>
        </>
      ) : (
      <GroupedList
        title={standalone ? t("controlAdmin:personalLibraries.listTitle") : t("controlAdmin:personalLibraries.title")}
        note={standalone ? [totals, t("controlAdmin:personalLibraries.listNote")].filter(Boolean).join(" · ") : t("controlAdmin:personalLibraries.listNoteShort")}
      >
        {/* The list's own action leads it (UI-CONVENTIONS: add-style rows go first). */}
        <AddRow
          icon={<UserRoundCheck size={17} />}
          label={t("controlAdmin:personalLibraries.adopt")}
          onClick={() => { setAdoptLibrary(""); setAdoptMember(""); setActionError(""); setAdoptOpen(true); }}
        />
        {listRows && view.libraries.length === 0 && <InfoRow icon={<BookOpen size={17} />} label={t("controlAdmin:personalLibraries.none")} />}
        {listRows && inUse.map((library) => {
          const row = {
            icon: <BookOpen size={17} />,
            label: standalone ? t("controlAdmin:personalLibraries.whose", { name: library.ownerName }) : library.ownerName,
            sub: standalone
              ? (library.adoptedAt ? t("controlAdmin:personalLibraries.adoptedOn", { date: formatDate(library.adoptedAt) }) : t("controlAdmin:personalLibraries.phonesCount", { count: library.phones }))
              : `${formatBytes(library.sizeBytes)} · ${t("controlAdmin:personalLibraries.phonesCount", { count: library.phones })}`,
            value: standalone ? formatBytes(library.sizeBytes) : undefined
          };
          // Only a library the server says you may manage — your own — opens its
          // Manage page; someone else's is private even to an admin, so its row says
          // whose it is and how big, and leads nowhere ("Library not found" otherwise).
          const canOpen = galleries.find((gallery) => gallery.id === library.id)?.canManageLibrary === true;
          return canOpen
            ? <NavRow key={library.id} {...row} href={libraryManageHref(library.id)} />
            : <InfoRow key={library.id} {...row} />;
        })}
      </GroupedList>
      )}

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
      </>
      )}

      {limitOpen && (
        <Modal title={t("controlAdmin:personalLibraries.limitDialogTitle")} onClose={() => { saveCustomLimit(); setLimitOpen(false); }}>
          {/* A tap saves; another limit saves when you leave the field or press Enter. */}
          <GroupedList note={t("controlAdmin:personalLibraries.limitNote")}>
            <CheckRow label={t("controlAdmin:personalLibraries.limitPlaceholder")} checked={settings.sizeLimitGB == null} disabled={saving} onSelect={() => { setLimitText(""); void save({ sizeLimitGB: null }); }} />
            {LIMIT_CHOICES.map((limit) => (
              <CheckRow
                key={limit}
                label={t("controlAdmin:personalLibraries.limitEach", { size: limit })}
                checked={settings.sizeLimitGB === limit}
                disabled={saving}
                onSelect={() => { setLimitText(""); void save({ sizeLimitGB: limit }); }}
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
          {error && <MessageBox tone="error" title={t("controlAdmin:personalLibraries.saveFailed")}>{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="primary" onClick={() => { saveCustomLimit(); setLimitOpen(false); }}>{t("controlAdmin:personalLibraries.done")}</Button>
          </div>
        </Modal>
      )}

      {whoOpen && (
        // The standard access window, on/off (no roles): Everyone has access or not;
        // otherwise the members and groups listed do. Each change saves at once.
        <AccessDialog
          title={t("controlAdmin:personalLibraries.whoDialogTitle")}
          error={error}
          errorTitle={t("controlAdmin:personalLibraries.saveFailed")}
          busy={saving}
          onClose={() => setWhoOpen(false)}
        >
          <AccessControl
            roles={[]}
            members={settings.subjects.map((subject) => ({
              subjectType: subject.type,
              subjectId: subject.id,
              name: subject.type === "group" ? groups.find((g) => g.id === subject.id)?.name ?? subject.id : memberName(subject.id) || subject.id,
              role: "",
              missing: subject.type === "group" ? !groups.some((g) => g.id === subject.id) : !members.some((m) => m.id === subject.id)
            }))}
            candidates={{
              users: members.map((member) => ({ id: member.id, name: member.displayName })),
              groups: groups.map((group) => ({ id: group.id, name: group.name }))
            }}
            everyone={{
              role: settings.who === "everyone" ? "yes" : null,
              hint: t("controlAdmin:personalLibraries.whoEveryone"),
              publicTag: false,
              options: [
                { value: ACCESS_NONE, label: t("common:access.noAccess"), tagline: "", dot: ACCESS_ROLE_DOT.none },
                { value: "yes", label: t("common:access.hasAccess"), tagline: "", dot: ACCESS_ROLE_DOT.contributor }
              ],
              onChange: (role) => void save({ who: role ? "everyone" : "chosen" })
            }}
            busy={saving}
            emptyHint={settings.who === "everyone" ? "" : t("controlAdmin:personalLibraries.nobodyChosen")}
            onGrant={(type, id) => toggleSubject({ type, id }, true)}
            // The whole list is one setting: everyone ticked goes in one save.
            onGrantMany={(subjects) => save({ subjects: [...settings.subjects, ...subjects.map((subject) => ({ type: subject.subjectType, id: subject.subjectId }))] })}
            onRevoke={(type, id) => toggleSubject({ type, id }, false)}
            onRevokeMany={(subjects) => save({ subjects: settings.subjects.filter((s) => !subjects.some((r) => r.subjectType === s.type && r.subjectId === s.id)) })}
          />
        </AccessDialog>
      )}

      {whereOpen && (
        <Modal
          title={t("controlAdmin:personalLibraries.whereDialogTitle")}
          busy={saving}
          onClose={() => setWhereOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!whereRoot || !folderText.trim()) return;
            void save({ storageRootId: whereRoot, folder: folderText.trim() }).then((ok) => { if (ok) setWhereOpen(false); });
          }}
        >
          <p>{t("controlAdmin:personalLibraries.whereIntro")}</p>
          {storageRoots.length === 0
            ? <MessageBox tone="warning" title={t("controlAdmin:personalLibraries.noRoot")}>{t("controlAdmin:personalLibraries.noRootBody")}</MessageBox>
            : (
              <>
                <SelectField
                  label={t("controlAdmin:personalLibraries.root")}
                  value={whereRoot}
                  options={storageRoots.map((root) => ({ value: root.id, label: `${root.name} — ${root.path}` }))}
                  onChange={setWhereRoot}
                />
                <Field label={t("controlAdmin:personalLibraries.folder")} value={folderText} onChange={setFolderText} />
                {previewPath && <p className="muted">{t("controlAdmin:personalLibraries.preview", { path: previewPath })}</p>}
                {view.libraries.length > 0 && <p className="muted">{t("controlAdmin:personalLibraries.existingStay", { count: view.libraries.length })}</p>}
              </>
            )}
          {error && <MessageBox tone="error" title={t("controlAdmin:personalLibraries.saveFailed")}>{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setWhereOpen(false)} disabled={saving} autoFocus>{t("common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={saving || !whereRoot || !folderText.trim()}>
              {saving ? t("controlAdmin:personalLibraries.saving") : t("controlAdmin:personalLibraries.saveWhere")}
            </Button>
          </div>
        </Modal>
      )}

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
