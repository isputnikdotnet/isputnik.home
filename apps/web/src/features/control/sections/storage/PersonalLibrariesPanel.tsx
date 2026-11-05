import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { UserRoundCheck } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { ChoiceGroup } from "../../../../shared/ChoiceGroup";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { formatDate } from "../../../../shared/dates";
import { Field } from "../../../../shared/Field";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { SelectField } from "../../../../shared/SelectField";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";
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

// Library › Storage › Personal libraries (docs/photo-sync-plan.md, phase 1,
// decision 4 and open questions 6–8): whether members may have a private library
// of their own, who, where they are made and how big they may grow — and the
// libraries there are, as whose they are and their size. Never what is in them:
// an admin cannot open someone else's personal library.
export function PersonalLibrariesPanel({ storageRoots }: { storageRoots: StorageRoot[] }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<AdminView | null>(null);
  const [draft, setDraft] = useState<PersonalSettings | null>(null);
  const [limitText, setLimitText] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [galleries, setGalleries] = useState<GalleryLibraryOption[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
    setDraft(next.settings);
    setLimitText(next.settings.sizeLimitGB == null ? "" : String(next.settings.sizeLimitGB));
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

  const owners = useMemo(() => new Set((view?.libraries ?? []).filter((l) => !l.orphanedAt).map((l) => l.ownerId)), [view]);
  const membersWithout = members.filter((member) => !owners.has(member.id));
  const adoptable = galleries.filter((library) => !library.role && !library.personal);
  const memberName = (id: string) => members.find((m) => m.id === id)?.displayName ?? "";
  const libraryName = (id: string) => galleries.find((l) => l.id === id)?.name ?? "";

  if (!view || !draft) {
    return error ? <MessageBox tone="error" title={t("controlAdmin:personalLibraries.errorTitle")}>{error}</MessageBox> : null;
  }

  const hasSubject = (subject: Subject) => draft.subjects.some((s) => s.type === subject.type && s.id === subject.id);
  const toggleSubject = (subject: Subject, on: boolean) => setDraft({
    ...draft,
    subjects: on ? [...draft.subjects, subject] : draft.subjects.filter((s) => !(s.type === subject.type && s.id === subject.id))
  });

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const limit = limitText.trim() === "" ? null : Number(limitText.replace(",", "."));
    if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
      setError(t("controlAdmin:personalLibraries.badLimit"));
      return;
    }
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      apply(await api<AdminView>("/api/storage/personal-libraries/settings", {
        method: "PUT",
        body: JSON.stringify({ ...draft, sizeLimitGB: limit })
      }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:personalLibraries.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

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

  const rootOptions = [
    { value: "", label: t("controlAdmin:personalLibraries.noRoot") },
    ...storageRoots.map((root) => ({ value: root.id, label: `${root.name} — ${root.path}` }))
  ];

  return (
    <section id="personal-libraries" className="storage-section">
      <div className="storage-section-head">
        <div>
          <h2>{t("controlAdmin:personalLibraries.title")}</h2>
          <p>{t("controlAdmin:personalLibraries.description")}</p>
        </div>
        <Button variant="secondary" onClick={() => { setAdoptLibrary(""); setAdoptMember(""); setActionError(""); setAdoptOpen(true); }}>
          <UserRoundCheck size={18} aria-hidden="true" />
          <span>{t("controlAdmin:personalLibraries.adopt")}</span>
        </Button>
      </div>

      <form className="personal-libraries-form" onSubmit={save}>
        <ToggleSwitch
          checked={draft.enabled}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
          label={t("controlAdmin:personalLibraries.enabled")}
        />
        <SelectField
          label={t("controlAdmin:personalLibraries.root")}
          value={draft.storageRootId ?? ""}
          options={rootOptions}
          onChange={(value) => setDraft({ ...draft, storageRootId: value || null })}
        />
        <Field
          label={t("controlAdmin:personalLibraries.folder")}
          value={draft.folder}
          onChange={(folder) => setDraft({ ...draft, folder })}
        />
        {view.parentFolder && <p className="muted">{t("controlAdmin:personalLibraries.createdIn", { path: view.parentFolder })}</p>}
        <ChoiceGroup
          legend={t("controlAdmin:personalLibraries.who")}
          value={draft.who}
          onChange={(who) => setDraft({ ...draft, who })}
          options={[
            { value: "everyone", label: t("controlAdmin:personalLibraries.whoEveryone") },
            { value: "chosen", label: t("controlAdmin:personalLibraries.whoChosen") }
          ]}
        />
        {draft.who === "chosen" && (
          <div className="personal-libraries-subjects">
            {groups.map((group) => (
              <ToggleSwitch
                key={`g-${group.id}`}
                checked={hasSubject({ type: "group", id: group.id })}
                onChange={(on) => toggleSubject({ type: "group", id: group.id }, on)}
                label={t("controlAdmin:personalLibraries.groupLabel", { name: group.name })}
              />
            ))}
            {members.map((member) => (
              <ToggleSwitch
                key={`u-${member.id}`}
                checked={hasSubject({ type: "user", id: member.id })}
                onChange={(on) => toggleSubject({ type: "user", id: member.id }, on)}
                label={member.displayName}
              />
            ))}
          </div>
        )}
        <Field
          label={t("controlAdmin:personalLibraries.limit")}
          value={limitText}
          onChange={setLimitText}
          required={false}
          placeholder={t("controlAdmin:personalLibraries.limitPlaceholder")}
        />
        {error && <MessageBox tone="error" title={t("controlAdmin:personalLibraries.saveFailed")}>{error}</MessageBox>}
        {saved && <MessageBox tone="success" title={t("controlAdmin:personalLibraries.saved")}>{t("controlAdmin:personalLibraries.savedBody")}</MessageBox>}
        <div className="modal-actions">
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:personalLibraries.save")}
          </Button>
        </div>
      </form>

      <h3>{t("controlAdmin:personalLibraries.listTitle")}</h3>
      <p className="muted">{t("controlAdmin:personalLibraries.listNote")}</p>
      {view.libraries.length === 0 ? (
        <p className="management-empty">{t("controlAdmin:personalLibraries.none")}</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid datagrid-phone-stack">
            <thead>
              <tr>
                <th>{t("controlAdmin:personalLibraries.thWhose")}</th>
                <th className="col-num">{t("controlAdmin:personalLibraries.thSize")}</th>
                <th>{t("controlAdmin:personalLibraries.thState")}</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {view.libraries.map((library) => (
                <tr key={library.id}>
                  <td><strong>{t("controlAdmin:personalLibraries.whose", { name: library.ownerName })}</strong></td>
                  <td className="col-num" data-label={t("controlAdmin:personalLibraries.thSize")}>{formatBytes(library.sizeBytes)}</td>
                  <td data-label={t("controlAdmin:personalLibraries.thState")}>
                    {library.orphanedAt
                      ? t("controlAdmin:personalLibraries.orphanedOn", { date: formatDate(library.orphanedAt) })
                      : library.adoptedAt
                        ? t("controlAdmin:personalLibraries.adoptedOn", { date: formatDate(library.adoptedAt) })
                        : t("controlAdmin:personalLibraries.inUse")}
                  </td>
                  <td className="col-actions">
                    {library.orphanedAt && (
                      <>
                        <Button variant="text" onClick={() => { setHandOverMember(""); setActionError(""); setHandOver(library); }}>
                          {t("controlAdmin:personalLibraries.handOver")}
                        </Button>
                        <Button variant="text" danger onClick={() => { setActionError(""); setPending({ kind: "delete", library }); }}>
                          {t("controlAdmin:personalLibraries.delete")}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    </section>
  );
}
