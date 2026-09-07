import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Image, Images, Inbox } from "lucide-react";
import { api } from "../../../api";
import { followRoute, galleryInboxHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { SelectField } from "../../../shared/SelectField";
import { ControlSectionHead } from "../ControlSectionHead";

// The house's gallery settings — docs/photo-review-plan.md, phase 0.
//
// Two things, each of which used to live somewhere harder to find. The "Made
// in the app" library is the ONE gallery library every app-made file lands
// in: story narration, family-tree uploads, rendered slideshow movies. It
// replaced three separate settings that were the same question asked three
// times. And a Photo Inbox is set up here in one step — a folder inside a
// storage container, a library over it with the Inbox flag on, and its first
// scan — instead of through a switch on a library's Access tab.

interface HouseDto {
  library: { id: string; name: string } | null;
  folders: { recordings: string; familyTree: string; movies: string };
}

interface InboxSummary { id: string; name: string; count: number }
interface StorageRoot { id: string; name: string; path: string }

export function GallerySettingsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [house, setHouse] = useState<HouseDto | null>(null);
  const [libraries, setLibraries] = useState<{ id: string; name: string; inbox: boolean }[]>([]);
  const [libraryId, setLibraryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [inboxes, setInboxes] = useState<InboxSummary[]>([]);
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [inboxName, setInboxName] = useState("");
  const [rootId, setRootId] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; root: string } | null>(null);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    Promise.all([
      api<HouseDto>("/api/library/gallery/house-library"),
      api<{ libraries: { id: string; name: string; inbox: boolean }[] }>("/api/library/gallery-libraries?manage=1"),
      api<{ inboxes: InboxSummary[] }>("/api/library/gallery/inbox"),
      api<{ roots: StorageRoot[] }>("/api/storage/roots")
    ])
      .then(([houseDto, libs, inboxList, rootList]) => {
        setHouse(houseDto);
        setLibraryId(houseDto.library?.id ?? "");
        setLibraries(libs.libraries.map((library) => ({ id: library.id, name: library.name, inbox: library.inbox })));
        setInboxes(inboxList.inboxes);
        setRoots(rootList.roots);
        if (rootList.roots.length > 0) setRootId(rootList.roots[0].id);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:gallerySettings.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const saveHouse = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const payload = await api<HouseDto>("/api/library/gallery/house-library", {
        method: "PUT",
        body: JSON.stringify({ libraryId: libraryId || null })
      });
      setHouse(payload);
      setLibraryId(payload.library?.id ?? "");
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common:errors.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  const createInbox = async (event: FormEvent) => {
    event.preventDefault();
    const name = inboxName.trim() || t("controlAdmin:gallerySettings.inboxNamePlaceholder");
    setCreating(true);
    setCreateError("");
    setCreated(null);
    try {
      const payload = await api<{ library: { id: string; name: string }; inboxes: InboxSummary[] }>("/api/library/gallery/inbox/create", {
        method: "POST",
        body: JSON.stringify({ name, storageRootId: rootId })
      });
      setInboxes(payload.inboxes);
      setCreated({ name: payload.library.name, root: roots.find((root) => root.id === rootId)?.name ?? "" });
      setShowCreate(false);
      setInboxName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("controlAdmin:gallerySettings.inboxCreateFailed"));
    } finally {
      setCreating(false);
    }
  };

  const folders = house?.folders ?? { recordings: "Story recordings", familyTree: "Family tree", movies: "Slideshow movies" };
  const createForm = showCreate || inboxes.length === 0;

  return (
    <>
      <ControlSectionHead
        section="gallerySettings"
        icon={<Image size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:gallerySettings.headDescription")}
      />

      {loadError && <MessageBox tone="error" title={t("controlAdmin:gallerySettings.loadFailed")}>{loadError}</MessageBox>}

      <section className="config-block">
        <h2>{t("controlAdmin:gallerySettings.houseTitle")}</h2>
        <p className="muted">{t("controlAdmin:gallerySettings.houseIntro")}</p>
        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form className="mail-form" onSubmit={saveHouse}>
            <SelectField
              label={t("controlAdmin:gallerySettings.houseLabel")}
              icon={<Images size={17} />}
              value={libraryId}
              onChange={setLibraryId}
              disabled={saving}
              options={[
                { value: "", label: t("controlAdmin:gallerySettings.houseNone") },
                ...libraries.filter((library) => !library.inbox).map((library) => ({ value: library.id, label: library.name }))
              ]}
            />
            <p className="muted">{t("controlAdmin:gallerySettings.houseFolders", folders)}</p>
            <p className="muted">{t("controlAdmin:gallerySettings.houseNote")}</p>

            {saveError && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:gallerySettings.houseSaved")}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className="config-block">
        <h2>{t("controlAdmin:gallerySettings.inboxTitle")}</h2>
        <p className="muted">{t("controlAdmin:gallerySettings.inboxIntro")}</p>

        {!loading && inboxes.length > 0 && (
          <>
            <p>{t("controlAdmin:gallerySettings.inboxExisting", { count: inboxes.length })}</p>
            <ul className="gallery-settings-inboxes">
              {inboxes.map((inbox) => (
                <li key={inbox.id}>
                  <Inbox size={16} aria-hidden="true" />
                  <span>{inbox.name}</span>
                  <a href={galleryInboxHref(inbox.id)} onClick={(event) => followRoute(event, galleryInboxHref(inbox.id))}>
                    {t("controlAdmin:gallerySettings.inboxOpen")}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        {created && (
          <MessageBox tone="success" title={t("controlAdmin:gallerySettings.inboxCreatedTitle")}>
            {t("controlAdmin:gallerySettings.inboxCreatedBody", created)}
          </MessageBox>
        )}

        {!loading && (createForm ? (
          roots.length === 0 ? (
            <MessageBox tone="info" title={t("controlAdmin:gallerySettings.inboxTitle")}>
              {t("controlAdmin:gallerySettings.inboxNoRoots")}
            </MessageBox>
          ) : (
            <form className="mail-form" onSubmit={createInbox}>
              <label className="mail-field">
                <span>{t("controlAdmin:gallerySettings.inboxNameLabel")}</span>
                <input
                  value={inboxName}
                  onChange={(event) => setInboxName(event.target.value)}
                  placeholder={t("controlAdmin:gallerySettings.inboxNamePlaceholder")}
                  maxLength={80}
                  disabled={creating}
                />
              </label>
              <SelectField
                label={t("controlAdmin:gallerySettings.inboxRootLabel")}
                icon={<HardDrive size={17} />}
                value={rootId}
                onChange={setRootId}
                disabled={creating}
                options={roots.map((root) => ({ value: root.id, label: `${root.name} — ${root.path}` }))}
              />
              {createError && <MessageBox tone="error" title={t("controlAdmin:gallerySettings.inboxCreateFailed")}>{createError}</MessageBox>}
              <div className="mail-actions">
                <Button variant="primary" type="submit" disabled={creating || !rootId}>
                  {creating ? t("controlAdmin:gallerySettings.inboxCreating") : t("controlAdmin:gallerySettings.inboxCreate")}
                </Button>
                {inboxes.length > 0 && (
                  <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={creating}>{t("common:common.cancel")}</Button>
                )}
              </div>
            </form>
          )
        ) : (
          <div className="mail-actions">
            <Button variant="secondary" onClick={() => { setCreated(null); setShowCreate(true); }}>
              {t("controlAdmin:gallerySettings.inboxAnother")}
            </Button>
          </div>
        ))}
        <p className="muted">{t("controlAdmin:gallerySettings.inboxExistingNote")}</p>
      </section>
    </>
  );
}
