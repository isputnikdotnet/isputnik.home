import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { VIDEO_API, type VideoLibraryRef } from "../video/types";

// Profile › TV profiles (docs/tv-profiles-plan.md, phase P1): views of this
// account that a linked TV picks from instead of the account's name — Kids,
// Russian, Classic. Each only narrows what the account sees: fewer video
// libraries, fewer sections, and its own video page (set on the video page's
// Customize). Made and changed here; a TV only wears them.

export const SECTION_KEYS = ["video", "games", "gallery", "audiobooks", "ebooks", "stories", "familyTree"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface ViewingProfile {
  id: string;
  name: string;
  avatar: string;
  restricted: boolean;
  libraries: string[] | null;
  sections: SectionKey[] | null;
  ownRows: boolean;
}

export interface ProfilesAnswer {
  profiles: ViewingProfile[];
  current: string | null;
  avatars: string[];
  max: number;
  editable: boolean;
}

export const PROFILES_API = "/api/profiles";

interface Draft {
  name: string;
  avatar: string;
  restricted: boolean;
  libraries: string[] | null;
  sections: SectionKey[] | null;
}

/** A profile's picture: its colour with the first letter of its name. */
export function ProfileAvatar({ name, avatar, size = 40 }: { name: string; avatar: string; size?: number }) {
  return (
    <span className={`tv-profile-avatar tv-profile-avatar-${avatar}`} style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function ViewingProfilesSection() {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<ProfilesAnswer | null>(null);
  const [libraries, setLibraries] = useState<VideoLibraryRef[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ViewingProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setAnswer(await api<ProfilesAnswer>(PROFILES_API));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.tvProfiles.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
    // The libraries this person may see; none when Video isn't set up for them.
    api<{ libraries: VideoLibraryRef[] }>(`${VIDEO_API}/libraries`)
      .then((payload) => setLibraries(payload.libraries))
      .catch(() => setLibraries([]));
  }, [load]);

  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));
  const sectionName = (key: SectionKey) => t(`profile.tvProfiles.section.${key}`);

  const describe = (profile: ViewingProfile) => {
    const parts: string[] = [];
    parts.push(profile.libraries === null
      ? t("profile.tvProfiles.everyLibrary")
      : profile.libraries.length === 0
        ? t("profile.tvProfiles.noLibraries")
        : profile.libraries.map((id) => libraryNames[id] ?? id).join(", "));
    if (profile.sections !== null) {
      parts.push(profile.sections.length === 0 ? t("profile.tvProfiles.noSections") : profile.sections.map(sectionName).join(", "));
    }
    parts.push(profile.ownRows ? t("profile.tvProfiles.ownPage") : t("profile.tvProfiles.yourPage"));
    return parts.join(" · ");
  };

  const openNew = () => {
    setFormError("");
    setEditing({ id: null, draft: { name: "", avatar: answer?.avatars[(answer.profiles.length) % answer.avatars.length] ?? "blue", restricted: false, libraries: null, sections: null } });
  };
  const openEdit = (profile: ViewingProfile) => {
    setFormError("");
    setEditing({ id: profile.id, draft: { name: profile.name, avatar: profile.avatar, restricted: profile.restricted, libraries: profile.libraries, sections: profile.sections } });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setFormError("");
    try {
      const body = JSON.stringify({ ...editing.draft, name: editing.draft.name.trim() });
      const next = editing.id
        ? await api<ProfilesAnswer>(`${PROFILES_API}/${editing.id}`, { method: "PATCH", body })
        : await api<ProfilesAnswer>(PROFILES_API, { method: "POST", body });
      setAnswer(next);
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("profile.tvProfiles.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const move = async (index: number, by: number) => {
    if (!answer) return;
    const ids = answer.profiles.map((profile) => profile.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    try {
      setAnswer(await api<ProfilesAnswer>(`${PROFILES_API}/order`, { method: "PUT", body: JSON.stringify({ ids }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.tvProfiles.saveFailed"));
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      setAnswer(await api<ProfilesAnswer>(`${PROFILES_API}/${pendingDelete.id}`, { method: "DELETE" }));
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.tvProfiles.deleteFailed"));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const profiles = answer?.profiles ?? [];
  const full = answer ? profiles.length >= answer.max : true;

  return (
    <section className="opds-access tv-profiles" aria-labelledby="tv-profiles-heading">
      <h2 id="tv-profiles-heading">{t("profile.tvProfiles.heading")}</h2>
      <p className="opds-intro">{t("profile.tvProfiles.intro")}</p>
      <p className="opds-intro">
        {t("profile.tvProfiles.rowsHint")}{" "}
        <a href="/help/tv-app" onClick={(event) => followRoute(event, "/help/tv-app")}>{t("profile.tvProfiles.guide")}</a>
      </p>

      {error && <MessageBox tone="error" title={t("profile.tvProfiles.loadFailed")}>{error}</MessageBox>}
      {answer && !answer.editable && (
        <MessageBox tone="info" title={t("profile.tvProfiles.onTvTitle")}>{t("profile.tvProfiles.onTvBody")}</MessageBox>
      )}

      {answer?.editable && (
        <div className="opds-actions">
          <Button variant="primary" disabled={full} title={full ? t("profile.tvProfiles.full", { max: answer.max }) : undefined} onClick={openNew}>
            <Plus size={16} aria-hidden="true" /> {t("profile.tvProfiles.create")}
          </Button>
        </div>
      )}

      <div className="opds-token-list">
        {answer && profiles.length === 0 && <p className="opds-intro">{t("profile.tvProfiles.none")}</p>}
        {profiles.map((profile, index) => (
          <div className="opds-token-row tv-profile-row" key={profile.id}>
            <ProfileAvatar name={profile.name} avatar={profile.avatar} />
            <div className="opds-token-meta">
              <strong>
                {profile.name}
                {profile.restricted && (
                  <span className="tv-profile-badge"><Lock size={12} aria-hidden="true" /> {t("profile.tvProfiles.restrictedBadge")}</span>
                )}
              </strong>
              <span className="opds-intro">{describe(profile)}</span>
            </div>
            {answer?.editable && (
              <>
                <Button variant="icon" aria-label={t("profile.tvProfiles.moveUp", { name: profile.name })} title={t("profile.tvProfiles.moveUp", { name: profile.name })} disabled={index === 0} onClick={() => void move(index, -1)}>
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button variant="icon" aria-label={t("profile.tvProfiles.moveDown", { name: profile.name })} title={t("profile.tvProfiles.moveDown", { name: profile.name })} disabled={index === profiles.length - 1} onClick={() => void move(index, 1)}>
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
                <Button variant="icon" aria-label={t("profile.tvProfiles.edit", { name: profile.name })} title={t("profile.tvProfiles.edit", { name: profile.name })} onClick={() => openEdit(profile)}>
                  <Pencil size={16} aria-hidden="true" />
                </Button>
                <Button variant="icon" danger aria-label={t("profile.tvProfiles.delete", { name: profile.name })} title={t("profile.tvProfiles.delete", { name: profile.name })} onClick={() => setPendingDelete(profile)}>
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>

      {editing && answer && (
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
          title={t("profile.tvProfiles.deleteTitle", { name: pendingDelete.name })}
          confirmLabel={t("profile.tvProfiles.deleteConfirm")}
          busyLabel={t("profile.tvProfiles.deleting")}
          busy={deleting}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setPendingDelete(null)}
        >
          {t("profile.tvProfiles.deleteBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}

function ProfileForm({ isNew, draft, avatars, libraries, busy, error, onChange, onSubmit, onClose }: {
  isNew: boolean;
  draft: Draft;
  avatars: string[];
  libraries: VideoLibraryRef[];
  busy: boolean;
  error: string;
  onChange: (draft: Draft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter((each) => each !== value) : [...list, value]);
  const allLibraries = draft.libraries === null;
  const allSections = draft.sections === null;

  return (
    <Modal
      variant="card"
      className="tv-profile-modal"
      title={isNew ? t("profile.tvProfiles.createTitle") : t("profile.tvProfiles.editTitle")}
      busy={busy}
      onClose={onClose}
      onSubmit={onSubmit}
    >
      <div className="tv-profile-form">
        <Field label={t("profile.tvProfiles.fieldName")} value={draft.name} onChange={(name) => onChange({ ...draft, name: name.slice(0, 40) })} placeholder={t("profile.tvProfiles.namePlaceholder")} />

        <fieldset className="tv-profile-checks">
          <legend>{t("profile.tvProfiles.fieldAvatar")}</legend>
          <div className="tv-profile-avatars" role="radiogroup" aria-label={t("profile.tvProfiles.fieldAvatar")}>
            {avatars.map((avatar) => (
              <Button
                key={avatar}
                variant="bare"
                className={`tv-profile-avatar-choice${draft.avatar === avatar ? " is-selected" : ""}`}
                role="radio"
                aria-checked={draft.avatar === avatar}
                aria-label={t(`profile.tvProfiles.avatar.${avatar}` as "profile.tvProfiles.avatar.blue")}
                title={t(`profile.tvProfiles.avatar.${avatar}` as "profile.tvProfiles.avatar.blue")}
                onClick={() => onChange({ ...draft, avatar })}
              >
                <ProfileAvatar name={draft.name || "?"} avatar={avatar} size={36} />
              </Button>
            ))}
          </div>
        </fieldset>

        <ChoiceGroup<"open" | "restricted">
          legend={t("profile.tvProfiles.fieldKind")}
          value={draft.restricted ? "restricted" : "open"}
          onChange={(kind) => onChange({
            ...draft,
            restricted: kind === "restricted",
            // A new restricted profile starts with Video alone; one chosen by hand stays.
            sections: kind === "restricted" && draft.sections === null ? ["video"] : draft.sections
          })}
          options={[
            { value: "open", label: t("profile.tvProfiles.kindOpen"), description: t("profile.tvProfiles.kindOpenHint") },
            { value: "restricted", label: t("profile.tvProfiles.kindRestricted"), description: t("profile.tvProfiles.kindRestrictedHint") }
          ]}
        />

        {libraries.length > 0 && (
          <fieldset className="tv-profile-checks">
            <legend>{t("profile.tvProfiles.fieldLibraries")}</legend>
            <p className="muted">{t("profile.tvProfiles.fieldLibrariesHint")}</p>
            <label>
              <input type="checkbox" checked={allLibraries} onChange={() => onChange({ ...draft, libraries: allLibraries ? libraries.map((entry) => entry.id) : null })} />
              <span>{t("profile.tvProfiles.everyLibrary")}</span>
            </label>
            {!allLibraries && libraries.map((entry) => (
              <label key={entry.id}>
                <input type="checkbox" checked={draft.libraries!.includes(entry.id)} onChange={() => onChange({ ...draft, libraries: toggle(draft.libraries!, entry.id) })} />
                <span>{entry.name}</span>
              </label>
            ))}
          </fieldset>
        )}

        <fieldset className="tv-profile-checks">
          <legend>{t("profile.tvProfiles.fieldSections")}</legend>
          <p className="muted">{t("profile.tvProfiles.fieldSectionsHint")}</p>
          <label>
            <input type="checkbox" checked={allSections} onChange={() => onChange({ ...draft, sections: allSections ? [...SECTION_KEYS] : null })} />
            <span>{t("profile.tvProfiles.everySection")}</span>
          </label>
          {!allSections && SECTION_KEYS.map((key) => (
            <label key={key}>
              <input type="checkbox" checked={draft.sections!.includes(key)} onChange={() => onChange({ ...draft, sections: toggle(draft.sections!, key) })} />
              <span>{t(`profile.tvProfiles.section.${key}`)}</span>
            </label>
          ))}
        </fieldset>

        {error && <MessageBox tone="error" title={t("profile.tvProfiles.saveFailed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>
            {busy ? t("profile.tvProfiles.saving") : isNew ? t("profile.tvProfiles.createConfirm") : t("profile.tvProfiles.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
