import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowDown, ArrowUp, KeyRound, Lock, Pencil, Plus, Trash2, Users } from "lucide-react";
import { ApiError, api } from "../../api";
import { Button } from "../../shared/Button";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SortMenu } from "../../shared/SortMenu";

// Viewing profiles (docs/tv-profiles-plan.md): the household's ways of watching video —
// Kids, Russian, Classic — Netflix-style. An admin sets them up here, on the video page
// (Customize › Profiles), with one household PIN; every TV and browser can wear one
// ("Watching as"). A profile only narrows what the signed-in account sees: fewer video
// libraries, and its own rows. The rest of the app stays the account's.

export interface ViewingProfile {
  id: string;
  name: string;
  avatar: string;
  restricted: boolean;
  libraries: string[] | null;
  ownRows: boolean;
}

export interface ProfilesAnswer {
  profiles: ViewingProfile[];
  current: string | null;
  avatars: string[];
  max: number;
  /** An admin at a keyboard, not inside a locked profile. */
  editable: boolean;
  /** The household has a PIN for leaving restricted profiles. */
  pinSet: boolean;
  /** Leaving the profile worn now needs that PIN. */
  locked: boolean;
}

export const PROFILES_API = "/api/profiles";

interface LibraryRef {
  id: string;
  name: string;
}

interface Draft {
  name: string;
  avatar: string;
  restricted: boolean;
  libraries: string[] | null;
}

/** A profile's picture: its colour with the first letter of its name. */
export function ProfileAvatar({ name, avatar, size = 40 }: { name: string; avatar: string; size?: number }) {
  return (
    <span className={`video-profile-avatar video-profile-avatar-${avatar}`} style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** The machine-readable reason a refusal came with (pin_needed, pin_wrong, pin_locked). */
const reasonOf = (err: unknown) => (err instanceof ApiError ? (err.body as { reason?: string } | undefined)?.reason : undefined);

/** The error a refused PIN came back with, in the viewer's words. */
function pinError(err: unknown, t: TFunction): string {
  const reason = reasonOf(err);
  if (reason === "pin_locked") return t("video.profiles.pin.locked");
  if (reason === "pin_wrong") return t("video.profiles.pin.wrong");
  return err instanceof Error ? err.message : t("video.profiles.pin.failed");
}

// ── Watching as: the video page's switch ─────────────────────────────────────

/** Who's watching on this browser: Everyone (all the account may see, no profile), or one
 *  of the household's profiles. Named as the TV names it (one account per TV, 2026-11-11). Leaving a locked profile asks for the PIN. Shown only when there are any. */
export function WatchingAs({ answer, onSwitched }: { answer: ProfilesAnswer; onSwitched: (next: ProfilesAnswer) => void }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const current = answer.profiles.find((profile) => profile.id === answer.current) ?? null;
  const ME = "";

  const switchTo = async (profileId: string | null, pin?: string) => {
    onSwitched(await api<ProfilesAnswer>(`${PROFILES_API}/switch`, { method: "POST", body: JSON.stringify({ profileId, pin }) }));
  };
  const choose = (value: string) => {
    const profileId = value === ME ? null : value;
    if (profileId === answer.current) return;
    if (answer.locked) setPending(profileId);
    else void switchTo(profileId).catch((err: unknown) => {
      if (reasonOf(err) === "pin_needed") setPending(profileId);
    });
  };

  return (
    <>
      <SortMenu
        presentation="labelled"
        value={answer.current ?? ME}
        ariaLabel={t("video.profiles.watchingAs")}
        icon={current ? <ProfileAvatar name={current.name} avatar={current.avatar} size={20} /> : <Users size={18} aria-hidden="true" />}
        onChange={choose}
        options={[
          { value: ME, label: t("video.profiles.everyone") },
          ...answer.profiles.map((profile) => ({ value: profile.id, label: profile.restricted && answer.pinSet ? `${profile.name} 🔒` : profile.name }))
        ]}
      />
      {pending !== undefined && (
        <PinPrompt
          onCancel={() => setPending(undefined)}
          onSubmit={async (pin) => {
            await switchTo(pending, pin);
            setPending(undefined);
          }}
        />
      )}
    </>
  );
}

/** The household PIN, asked to leave a locked profile. */
function PinPrompt({ onSubmit, onCancel }: { onSubmit: (pin: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pin.length < 4) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(pin);
    } catch (err) {
      setError(pinError(err, t));
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal variant="card" className="video-profile-modal" title={t("video.profiles.pin.enterTitle")} busy={busy} onClose={onCancel} onSubmit={submit}>
      <div className="video-profile-form">
        <p className="muted">{t("video.profiles.pin.enterBody")}</p>
        <Field label={t("video.profiles.pin.fieldPin")} type="password" autoComplete="off" value={pin} onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 8))} />
        {error && <MessageBox tone="error" title={t("video.profiles.pin.failed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || pin.length < 4}>{busy ? t("video.profiles.pin.checking") : t("video.profiles.pin.leave")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Customize › Profiles: an admin's ─────────────────────────────────────────

export function VideoProfilesManager({ answer, onChange }: { answer: ProfilesAnswer; onChange: (next: ProfilesAnswer) => void }) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<LibraryRef[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ViewingProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pinDialog, setPinDialog] = useState<"set" | "remove" | null>(null);

  useEffect(() => {
    // Every video library, not the ones a profile worn here narrows the page to.
    api<{ libraries: LibraryRef[] }>("/api/library/video-libraries?manage=1")
      .then((payload) => setLibraries(payload.libraries.map(({ id, name }) => ({ id, name }))))
      .catch(() => setLibraries([]));
  }, []);

  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));
  const describe = (profile: ViewingProfile) => [
    profile.libraries === null
      ? t("video.profiles.everyLibrary")
      : profile.libraries.length === 0 ? t("video.profiles.noLibraries") : profile.libraries.map((id) => libraryNames[id] ?? id).join(", "),
    profile.ownRows ? t("video.profiles.ownPage") : t("video.profiles.householdPage")
  ].join(" · ");

  const profiles = answer.profiles;
  const full = profiles.length >= answer.max;
  const anyRestricted = profiles.some((profile) => profile.restricted);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setFormError("");
    try {
      const body = JSON.stringify({ ...editing.draft, name: editing.draft.name.trim() });
      onChange(editing.id
        ? await api<ProfilesAnswer>(`${PROFILES_API}/${editing.id}`, { method: "PATCH", body })
        : await api<ProfilesAnswer>(PROFILES_API, { method: "POST", body }));
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("video.profiles.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const move = async (index: number, by: number) => {
    const ids = profiles.map((profile) => profile.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    try {
      onChange(await api<ProfilesAnswer>(`${PROFILES_API}/order`, { method: "PUT", body: JSON.stringify({ ids }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.profiles.saveFailed"));
    }
  };
  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      onChange(await api<ProfilesAnswer>(`${PROFILES_API}/${pendingDelete.id}`, { method: "DELETE" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.profiles.deleteFailed"));
    } finally {
      setPendingDelete(null);
      setDeleting(false);
    }
  };

  return (
    <div className="video-profiles">
      <p className="muted">{t("video.profiles.intro")}</p>
      {error && <MessageBox tone="error" title={t("video.profiles.saveFailed")}>{error}</MessageBox>}
      <ol className="video-rows-list video-profiles-list">
        {profiles.map((profile, index) => (
          <li key={profile.id}>
            <ProfileAvatar name={profile.name} avatar={profile.avatar} size={32} />
            <span className="video-rows-text">
              <strong>
                {profile.name}
                {profile.restricted && <span className="video-profile-badge"><Lock size={12} aria-hidden="true" /> {t("video.profiles.restrictedBadge")}</span>}
              </strong>
              <span>{describe(profile)}</span>
            </span>
            <Button variant="icon" aria-label={t("video.profiles.moveUp", { name: profile.name })} title={t("video.profiles.moveUp", { name: profile.name })} disabled={index === 0} onClick={() => void move(index, -1)}>
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
            <Button variant="icon" aria-label={t("video.profiles.moveDown", { name: profile.name })} title={t("video.profiles.moveDown", { name: profile.name })} disabled={index === profiles.length - 1} onClick={() => void move(index, 1)}>
              <ArrowDown size={16} aria-hidden="true" />
            </Button>
            <Button variant="icon" aria-label={t("video.profiles.edit", { name: profile.name })} title={t("video.profiles.edit", { name: profile.name })} onClick={() => { setFormError(""); setEditing({ id: profile.id, draft: { name: profile.name, avatar: profile.avatar, restricted: profile.restricted, libraries: profile.libraries } }); }}>
              <Pencil size={16} aria-hidden="true" />
            </Button>
            <Button variant="icon" danger aria-label={t("video.profiles.delete", { name: profile.name })} title={t("video.profiles.delete", { name: profile.name })} onClick={() => setPendingDelete(profile)}>
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      {profiles.length === 0 && <p className="muted">{t("video.profiles.none")}</p>}
      <Button
        variant="secondary"
        disabled={full}
        title={full ? t("video.profiles.full", { max: answer.max }) : undefined}
        onClick={() => { setFormError(""); setEditing({ id: null, draft: { name: "", avatar: answer.avatars[profiles.length % answer.avatars.length] ?? "blue", restricted: false, libraries: null } }); }}
      >
        <Plus size={16} aria-hidden="true" />
        {t("video.profiles.create")}
      </Button>

      <div className="video-profile-pin">
        <h3><KeyRound size={16} aria-hidden="true" /> {t("video.profiles.pin.heading")}</h3>
        <p className="muted">{answer.pinSet ? t("video.profiles.pin.introSet") : t("video.profiles.pin.intro")}</p>
        {anyRestricted && !answer.pinSet && (
          <MessageBox tone="warning" title={t("video.profiles.pin.missingTitle")}>{t("video.profiles.pin.missingBody")}</MessageBox>
        )}
        <div className="video-profile-pin-actions">
          <Button variant="secondary" onClick={() => setPinDialog("set")}>{answer.pinSet ? t("video.profiles.pin.change") : t("video.profiles.pin.set")}</Button>
          {answer.pinSet && <Button variant="text" onClick={() => setPinDialog("remove")}>{t("video.profiles.pin.remove")}</Button>}
        </div>
      </div>

      {editing && (
        <ProfileForm
          isNew={editing.id === null}
          draft={editing.draft}
          avatars={answer.avatars}
          libraries={libraries}
          busy={saving}
          error={formError}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSubmit={save}
          onClose={() => setEditing(null)}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={t("video.profiles.deleteTitle", { name: pendingDelete.name })}
          confirmLabel={t("video.profiles.deleteConfirm")}
          busyLabel={t("video.profiles.deleting")}
          busy={deleting}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setPendingDelete(null)}
        >
          {t("video.profiles.deleteBody")}
        </ConfirmDialog>
      )}
      {pinDialog && (
        <PinDialog
          mode={pinDialog}
          onClose={() => setPinDialog(null)}
          onDone={(next) => {
            onChange(next);
            setPinDialog(null);
          }}
        />
      )}
    </div>
  );
}

function ProfileForm({ isNew, draft, avatars, libraries, busy, error, onChange, onSubmit, onClose }: {
  isNew: boolean;
  draft: Draft;
  avatars: string[];
  libraries: LibraryRef[];
  busy: boolean;
  error: string;
  onChange: (draft: Draft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const allLibraries = draft.libraries === null;
  const toggle = (id: string) => {
    const list = draft.libraries ?? [];
    onChange({ ...draft, libraries: list.includes(id) ? list.filter((each) => each !== id) : [...list, id] });
  };
  return (
    <Modal variant="card" className="video-profile-modal" title={isNew ? t("video.profiles.createTitle") : t("video.profiles.editTitle")} busy={busy} onClose={onClose} onSubmit={onSubmit}>
      <div className="video-profile-form">
        <Field label={t("video.profiles.fieldName")} value={draft.name} onChange={(name) => onChange({ ...draft, name: name.slice(0, 40) })} placeholder={t("video.profiles.namePlaceholder")} />
        <fieldset className="video-row-checks">
          <legend>{t("video.profiles.fieldAvatar")}</legend>
          <div className="video-profile-avatars" role="radiogroup" aria-label={t("video.profiles.fieldAvatar")}>
            {avatars.map((avatar) => (
              <Button
                key={avatar}
                variant="bare"
                className={`video-profile-avatar-choice${draft.avatar === avatar ? " is-selected" : ""}`}
                role="radio"
                aria-checked={draft.avatar === avatar}
                aria-label={t(`video.profiles.avatar.${avatar}` as "video.profiles.avatar.blue")}
                title={t(`video.profiles.avatar.${avatar}` as "video.profiles.avatar.blue")}
                onClick={() => onChange({ ...draft, avatar })}
              >
                <ProfileAvatar name={draft.name || "?"} avatar={avatar} size={36} />
              </Button>
            ))}
          </div>
        </fieldset>
        <ChoiceGroup<"open" | "restricted">
          legend={t("video.profiles.fieldKind")}
          value={draft.restricted ? "restricted" : "open"}
          onChange={(kind) => onChange({ ...draft, restricted: kind === "restricted" })}
          options={[
            { value: "open", label: t("video.profiles.kindOpen"), description: t("video.profiles.kindOpenHint") },
            { value: "restricted", label: t("video.profiles.kindRestricted"), description: t("video.profiles.kindRestrictedHint") }
          ]}
        />
        {libraries.length > 0 && (
          <fieldset className="video-row-checks">
            <legend>{t("video.profiles.fieldLibraries")}</legend>
            <p className="muted">{t("video.profiles.fieldLibrariesHint")}</p>
            <label>
              <input type="checkbox" checked={allLibraries} onChange={() => onChange({ ...draft, libraries: allLibraries ? libraries.map((entry) => entry.id) : null })} />
              <span>{t("video.profiles.everyLibrary")}</span>
            </label>
            {!allLibraries && libraries.map((entry) => (
              <label key={entry.id}>
                <input type="checkbox" checked={draft.libraries!.includes(entry.id)} onChange={() => toggle(entry.id)} />
                <span>{entry.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <MessageBox tone="error" title={t("video.profiles.saveFailed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>
            {busy ? t("video.profiles.saving") : isNew ? t("video.profiles.createConfirm") : t("video.profiles.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Set, change or remove the household PIN. Both cost the admin's password. */
function PinDialog({ mode, onClose, onDone }: { mode: "set" | "remove"; onClose: () => void; onDone: (answer: ProfilesAnswer) => void }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const digits = (value: string) => value.replace(/\D/g, "").slice(0, 8);
  const valid = mode === "remove" ? password.length > 0 : /^\d{4,8}$/.test(pin) && pin === again && password.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError("");
    try {
      onDone(mode === "set"
        ? await api<ProfilesAnswer>(`${PROFILES_API}/pin`, { method: "PUT", body: JSON.stringify({ pin, currentPassword: password }) })
        : await api<ProfilesAnswer>(`${PROFILES_API}/pin`, { method: "DELETE", body: JSON.stringify({ currentPassword: password }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.profiles.pin.changeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal variant="card" className="video-profile-modal" title={mode === "set" ? t("video.profiles.pin.setTitle") : t("video.profiles.pin.removeTitle")} busy={busy} onClose={onClose} onSubmit={submit}>
      <div className="video-profile-form">
        <p className="muted">{mode === "set" ? t("video.profiles.pin.setBody") : t("video.profiles.pin.removeBody")}</p>
        {mode === "set" && (
          <>
            <Field label={t("video.profiles.pin.fieldNew")} type="password" autoComplete="off" value={pin} onChange={(value) => setPin(digits(value))} />
            <Field label={t("video.profiles.pin.fieldAgain")} type="password" autoComplete="off" value={again} onChange={(value) => setAgain(digits(value))} />
            {again.length >= 4 && pin !== again && <p className="muted">{t("video.profiles.pin.mismatch")}</p>}
          </>
        )}
        <Field label={t("video.profiles.pin.fieldPassword")} type="password" autoComplete="current-password" value={password} onChange={setPassword} />
        {error && <MessageBox tone="error" title={t("video.profiles.pin.changeFailed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={mode === "remove" ? "danger" : "primary"} type="submit" disabled={busy || !valid}>
            {busy ? t("video.profiles.saving") : mode === "set" ? t("video.profiles.pin.save") : t("video.profiles.pin.removeConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
