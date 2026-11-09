import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutList, Pencil, Plus } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectField } from "../../shared/SelectField";
import {
  VIDEO_HOME_API, VIDEO_ROWS_MAX, kindWord, newRowId, rowName,
  type VideoLayout, type VideoRow, type VideoRowKind, type VideoRowSort, type VideoTitlesRow
} from "./rows";
import { VIDEO_API, type VideoLibraryRef } from "./types";
import { PROFILES_API, VideoProfilesManager, type ProfilesAnswer, type ViewingProfile } from "./VideoProfiles";

type RowType = VideoRow["type"];
/** Whose rows: the person's own, (admins) the household's, or one of the household's
 *  viewing profiles (docs/tv-profiles-plan.md) as "profile:<id>"; "profiles" is the
 *  admin's list of the profiles themselves and their PIN. */
type Scope = "mine" | "everyone" | "profiles" | `profile:${string}`;
const profileIdOf = (scope: Scope) => (scope.startsWith("profile:") ? scope.slice("profile:".length) : null);

// Customize on the video page (docs/video-home-rows-plan.md): the rows, in order,
// each shown or hidden, and Add row. Everyone may make the page their own (Just
// me); an admin also edits the household's (Everyone), which is what everyone
// without rows of their own sees. Nothing is saved until Save rows.
export function VideoRowsEditor({ layout, libraries, onClose, onSaved }: {
  layout: VideoLayout;
  libraries: VideoLibraryRef[];
  onClose: () => void;
  onSaved: (layout: VideoLayout) => void;
}) {
  const { t } = useTranslation();
  // A page wearing a profile opens on that profile's rows (only an admin gets here then).
  const [scope, setScope] = useState<Scope>(layout.profileId ? `profile:${layout.profileId}` : layout.mine || !layout.editable ? "mine" : "everyone");
  // Each side as it is being edited. Someone with no rows of their own starts
  // "Just me" from the household's; an admin with their own asks for the
  // household's when they turn to Everyone.
  // A page wearing a profile shows that profile's rows; the others are asked for.
  const [drafts, setDrafts] = useState<Partial<Record<Scope, VideoRow[]>>>(() => (
    layout.profileId ? { [`profile:${layout.profileId}`]: layout.rows }
      : layout.mine ? { mine: layout.rows } : { mine: layout.rows, everyone: layout.rows }
  ));
  const [householdCustom, setHouseholdCustom] = useState(layout.custom);
  /** The row being added or changed; its index, or -1 for a new one. */
  const [editing, setEditing] = useState<{ index: number; row: VideoRow } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<"ask" | "busy" | null>(null);
  const [error, setError] = useState("");
  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));
  /** This person's own collections: what a Collection row may show. */
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const collectionNames = Object.fromEntries(collections.map((entry) => [entry.id, entry.name]));
  const rows = drafts[scope] ?? [];
  /** The household's viewing profiles, each a page of its own (an admin's to set up). */
  const [profilesAnswer, setProfilesAnswer] = useState<ProfilesAnswer | null>(null);
  const profiles: ViewingProfile[] = profilesAnswer?.editable ? profilesAnswer.profiles : [];
  /** Which profiles have rows of their own (else they follow the person's page). */
  const [profileOwn, setProfileOwn] = useState<Record<string, boolean>>(() => (layout.profileId ? { [layout.profileId]: Boolean(layout.own) } : {}));
  const profileId = profileIdOf(scope);
  const profile = profileId ? profiles.find((entry) => entry.id === profileId) ?? null : null;
  // A profile's rows can only name the libraries the profile shows.
  const rowLibraries = profile?.libraries ? libraries.filter((entry) => profile.libraries!.includes(entry.id)) : libraries;

  useEffect(() => {
    let live = true;
    api<ProfilesAnswer>(PROFILES_API)
      .then((payload) => { if (live) setProfilesAnswer(payload); })
      .catch(() => { if (live) setProfilesAnswer(null); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!profileId || drafts[scope]) return;
    let live = true;
    api<VideoLayout & { own: boolean }>(`${VIDEO_HOME_API}?scope=profile&profile=${encodeURIComponent(profileId)}`)
      .then((page) => {
        if (!live) return;
        setDrafts((current) => ({ ...current, [scope]: page.rows }));
        setProfileOwn((current) => ({ ...current, [profileId]: page.own }));
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    return () => { live = false; };
  }, [scope, profileId, drafts, t]);

  useEffect(() => {
    let live = true;
    api<{ collections: { id: string; name: string }[] }>("/api/collections")
      .then((payload) => { if (live) setCollections(payload.collections); })
      .catch(() => { if (live) setCollections([]); });
    return () => { live = false; };
  }, []);
  const loaded = drafts[scope] !== undefined;

  useEffect(() => {
    if (scope !== "mine" || drafts.mine) return;
    let live = true;
    api<VideoLayout>(`${VIDEO_HOME_API}?scope=mine`)
      .then((page) => { if (live) setDrafts((current) => ({ ...current, mine: page.rows })); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    return () => { live = false; };
  }, [scope, drafts.mine, t]);

  useEffect(() => {
    if (scope !== "everyone" || drafts.everyone) return;
    let live = true;
    api<VideoLayout>(`${VIDEO_HOME_API}?scope=everyone`)
      .then((household) => {
        if (!live) return;
        setDrafts((current) => ({ ...current, everyone: household.rows }));
        setHouseholdCustom(household.custom);
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    return () => { live = false; };
  }, [scope, drafts.everyone, t]);

  const setRows = (next: VideoRow[]) => setDrafts((current) => ({ ...current, [scope]: next }));
  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const next = rows.slice();
    [next[index], next[to]] = [next[to], next[index]];
    setRows(next);
  };
  const change = (index: number, row: VideoRow) => setRows(rows.map((each, at) => (at === index ? row : each)));

  const send = async (request: Promise<VideoLayout>) => {
    setError("");
    try {
      onSaved(await request);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.rows.saveFailed"));
      return false;
    }
    return true;
  };
  /** A profile's page isn't the one on screen: saving it leaves this page as it is. */
  const sendForProfile = async (request: Promise<unknown>) => {
    setError("");
    try {
      await request;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.rows.saveFailed"));
      return false;
    }
    onClose();
    return true;
  };
  const save = async () => {
    setSaving(true);
    if (profileId) await sendForProfile(api(VIDEO_HOME_API, { method: "PUT", body: JSON.stringify({ rows, scope: "profile", profileId }) }));
    else await send(api<VideoLayout>(VIDEO_HOME_API, { method: "PUT", body: JSON.stringify({ rows, scope }) }));
    setSaving(false);
  };
  const reset = async () => {
    setResetting("busy");
    const done = profileId
      ? await sendForProfile(api(`${VIDEO_HOME_API}?scope=profile&profile=${encodeURIComponent(profileId)}`, { method: "DELETE" }))
      : await send(api<VideoLayout>(`${VIDEO_HOME_API}?scope=${scope}`, { method: "DELETE" }));
    setResetting(done ? null : "ask");
  };

  const busy = saving || resetting === "busy";
  // Mine: back to the household's, when there are rows of one's own to drop.
  // Everyone: back to the default rows, when someone changed them.
  // A profile: back to following the person's page, when it has rows of its own.
  const canReset = profileId ? Boolean(profileOwn[profileId]) : scope === "mine" ? layout.mine : householdCustom;
  const describe = (row: VideoRow) => {
    if (row.type === "continue") return t("video.rows.typeContinueHint");
    if (row.type === "sets") return t("video.rows.typeSetsHint");
    if (row.type === "mylist") return t("video.rows.typeMyListHint");
    if (row.type === "collection") return t("video.rows.typeCollectionHint");
    const sort = row.sort === "added" ? t("video.sortAdded") : row.sort === "year" ? t("video.sortYear") : t("video.sortTitle");
    const where = row.libraries.length > 0 ? row.libraries.map((id) => libraryNames[id] ?? id).join(", ") : t("video.rows.everyLibrary");
    return [kindWord(row.kind, t), where, sort].join(" · ");
  };

  return (
    <Modal variant="panel" title={t("video.rows.title")} icon={<LayoutList size={20} />} className="video-rows-modal" busy={busy} onClose={onClose}>
      <div className="modal-tab-content">
        {editing ? (
          <RowForm
            row={editing.row}
            isNew={editing.index < 0}
            libraries={rowLibraries}
            libraryNames={libraryNames}
            collections={collections}
            onCancel={() => setEditing(null)}
            onDone={(row) => {
              if (editing.index < 0) setRows([...rows, row]);
              else change(editing.index, row);
              setEditing(null);
            }}
          />
        ) : (
          <>
            {layout.editable && (
              <div className="video-kind-tabs video-rows-scope" role="tablist" aria-label={t("video.rows.scopeAria")}>
                <Button variant="tab" selected={scope === "mine"} disabled={busy} onClick={() => setScope("mine")}>{t("video.rows.scopeMine")}</Button>
                {layout.editable && (
                  <Button variant="tab" selected={scope === "everyone"} disabled={busy} onClick={() => setScope("everyone")}>{t("video.rows.scopeEveryone")}</Button>
                )}
                {profiles.map((entry) => (
                  <Button key={entry.id} variant="tab" selected={scope === `profile:${entry.id}`} disabled={busy} onClick={() => setScope(`profile:${entry.id}`)}>
                    {entry.name}
                  </Button>
                ))}
                {profilesAnswer?.editable && (
                  <Button variant="tab" selected={scope === "profiles"} disabled={busy} onClick={() => setScope("profiles")}>{t("video.profiles.tab")}</Button>
                )}
              </div>
            )}
            {scope === "profiles" && profilesAnswer ? (
              <>
                <VideoProfilesManager answer={profilesAnswer} onChange={setProfilesAnswer} />
                <div className="modal-actions">
                  <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
                </div>
              </>
            ) : (<>
            <p className="muted">
              {profile
                ? (profileOwn[profile.id] ? t("video.rows.hintProfile", { name: profile.name }) : t("video.rows.hintProfileFollows", { name: profile.name }))
                : scope === "mine" ? t("video.rows.hintMine") : layout.mine ? t("video.rows.hintEveryoneButMine") : t("video.rows.hint")}
            </p>
            {error && <MessageBox tone="error" title={t("video.rows.saveFailed")}>{error}</MessageBox>}
            <ol className="video-rows-list">
              {rows.map((row, index) => {
                const name = rowName(row, t, libraryNames, collectionNames);
                return (
                  <li key={row.id} className={row.hidden ? "is-hidden" : undefined}>
                    <span className="video-rows-text">
                      <strong>{name}</strong>
                      <span>{row.hidden ? `${t("video.rows.hidden")} · ${describe(row)}` : describe(row)}</span>
                    </span>
                    <Button variant="icon" aria-label={t("video.rows.moveUp", { name })} title={t("video.rows.moveUp", { name })} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="icon" aria-label={t("video.rows.moveDown", { name })} title={t("video.rows.moveDown", { name })} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={row.hidden ? t("video.rows.show", { name }) : t("video.rows.hide", { name })}
                      title={row.hidden ? t("video.rows.show", { name }) : t("video.rows.hide", { name })}
                      onClick={() => change(index, { ...row, hidden: !row.hidden })}
                    >
                      {row.hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </Button>
                    <Button variant="icon" aria-label={t("video.rows.edit", { name })} title={t("video.rows.edit", { name })} onClick={() => setEditing({ index, row })}>
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="text" onClick={() => setRows(rows.filter((_, at) => at !== index))}>{t("video.rows.remove")}</Button>
                  </li>
                );
              })}
            </ol>
            {loaded && rows.length === 0 && <p className="muted">{t("video.rows.none")}</p>}
            <Button
              variant="secondary"
              disabled={!loaded || rows.length >= VIDEO_ROWS_MAX}
              title={rows.length >= VIDEO_ROWS_MAX ? t("video.rows.full", { max: VIDEO_ROWS_MAX }) : undefined}
              onClick={() => setEditing({ index: -1, row: { id: newRowId(), type: "titles", kind: "all", libraries: [], genres: [], sort: "added" } })}
            >
              <Plus size={16} aria-hidden="true" />
              {t("video.rows.add")}
            </Button>
            <div className="modal-actions">
              {canReset && (
                <Button variant="text" disabled={busy} onClick={() => setResetting("ask")}>
                  {profile ? t("video.rows.resetProfile") : scope === "mine" ? t("video.rows.resetMine") : t("video.rows.reset")}
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
              <Button variant="primary" disabled={busy || !loaded} onClick={() => void save()}>{saving ? t("video.rows.saving") : t("video.rows.save")}</Button>
            </div>
            </>)}
          </>
        )}
      </div>
      {resetting && (
        <ConfirmDialog
          title={profile ? t("video.rows.resetProfileTitle", { name: profile.name }) : scope === "mine" ? t("video.rows.resetMineTitle") : t("video.rows.resetTitle")}
          confirmLabel={profile ? t("video.rows.resetProfileConfirm") : scope === "mine" ? t("video.rows.resetMineConfirm") : t("video.rows.resetConfirm")}
          busyLabel={t("video.rows.resetting")}
          busy={resetting === "busy"}
          onConfirm={() => void reset()}
          onCancel={() => setResetting(null)}
        >
          {profile ? t("video.rows.resetProfileBody", { name: profile.name }) : scope === "mine" ? t("video.rows.resetMineBody") : t("video.rows.resetBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** One row's settings: what it is, and for a list of titles what it asks for. */
function RowForm({ row, isNew, libraries, libraryNames, collections, onCancel, onDone }: {
  row: VideoRow;
  isNew: boolean;
  libraries: VideoLibraryRef[];
  libraryNames: Record<string, string>;
  collections: { id: string; name: string }[];
  onCancel: () => void;
  onDone: (row: VideoRow) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VideoRow>(row);
  const [genres, setGenres] = useState<string[]>([]);
  const titles: VideoTitlesRow = draft.type === "titles" ? draft : { id: draft.id, type: "titles", kind: "all", libraries: [], genres: [], sort: "added" };

  useEffect(() => {
    let live = true;
    api<{ genres: string[] }>(`${VIDEO_API}/genres`)
      .then((payload) => { if (live) setGenres(payload.genres); })
      .catch(() => { if (live) setGenres([]); });
    return () => { live = false; };
  }, []);

  const setType = (type: RowType) => {
    const common = { id: draft.id, title: draft.title, hidden: draft.hidden };
    if (type === "titles") setDraft({ ...titles, ...common });
    else if (type === "collection") setDraft({ ...common, type, collectionId: collections[0]?.id ?? "" });
    else setDraft({ ...common, type });
  };
  const collectionNames = Object.fromEntries(collections.map((entry) => [entry.id, entry.name]));
  // A Collection row with no collection to show is not one yet.
  const ready = draft.type !== "collection" || Boolean(draft.collectionId);
  const setTitles = (patch: Partial<VideoTitlesRow>) => setDraft({ ...titles, title: draft.title, hidden: draft.hidden, ...patch });
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((each) => each !== value) : [...list, value]);
  // Libraries of the other kind say nothing in a row of one kind.
  const shownLibraries = libraries.filter((entry) => titles.kind === "all" || entry.kind === titles.kind);
  // A genre picked before the engine dropped it stays visible, so it can be unpicked.
  const genreOptions = [...new Set([...genres, ...titles.genres])];

  return (
    <div className="video-row-form">
      <h3>{isNew ? t("video.rows.addTitle") : t("video.rows.editTitle")}</h3>
      {isNew && (
        <ChoiceGroup<RowType>
          legend={t("video.rows.typeLegend")}
          value={draft.type}
          onChange={setType}
          options={[
            { value: "titles", label: t("video.rows.typeTitles"), description: t("video.rows.typeTitlesHint") },
            { value: "continue", label: t("video.continueWatching"), description: t("video.rows.typeContinueHint") },
            { value: "sets", label: t("video.viewSets"), description: t("video.rows.typeSetsHint") },
            { value: "mylist", label: t("video.myList.title"), description: t("video.rows.typeMyListHint") },
            { value: "collection", label: t("video.rows.typeCollection"), description: t("video.rows.typeCollectionHint") }
          ]}
        />
      )}
      {draft.type === "collection" && (collections.length > 0 ? (
        <SelectField<string>
          label={t("video.rows.fieldCollection")}
          value={draft.collectionId}
          onChange={(collectionId) => setDraft({ ...draft, collectionId })}
          options={collections.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      ) : (
        <MessageBox tone="info" title={t("video.rows.noCollectionsTitle")}>{t("video.rows.noCollectionsBody")}</MessageBox>
      ))}
      {draft.type === "titles" && (
        <>
          <SelectField<VideoRowKind>
            label={t("video.rows.fieldKind")}
            value={titles.kind}
            onChange={(kind) => setTitles({ kind, libraries: titles.libraries.filter((id) => kind === "all" || libraries.find((entry) => entry.id === id)?.kind === kind) })}
            options={[
              { value: "all", label: t("video.rows.kindBoth") },
              { value: "movies", label: t("video.movies") },
              { value: "shows", label: t("video.shows") }
            ]}
          />
          {shownLibraries.length > 1 && (
            <fieldset className="video-row-checks">
              <legend>{t("video.rows.fieldLibraries")}</legend>
              <p className="muted">{t("video.rows.fieldLibrariesHint")}</p>
              {shownLibraries.map((entry) => (
                <label key={entry.id}>
                  <input type="checkbox" checked={titles.libraries.includes(entry.id)} onChange={() => setTitles({ libraries: toggle(titles.libraries, entry.id) })} />
                  <span>{entry.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          {genreOptions.length > 0 && (
            <fieldset className="video-row-checks">
              <legend>{t("video.rows.fieldGenres")}</legend>
              <p className="muted">{t("video.rows.fieldGenresHint")}</p>
              {genreOptions.map((genre) => (
                <label key={genre}>
                  <input type="checkbox" checked={titles.genres.includes(genre)} onChange={() => setTitles({ genres: toggle(titles.genres, genre) })} />
                  <span>{genre}</span>
                </label>
              ))}
            </fieldset>
          )}
          <SelectField<VideoRowSort>
            label={t("video.rows.fieldSort")}
            value={titles.sort}
            onChange={(sort) => setTitles({ sort })}
            options={[
              { value: "added", label: t("video.sortAdded") },
              { value: "year", label: t("video.sortYear") },
              { value: "title", label: t("video.sortTitle") }
            ]}
          />
        </>
      )}
      <Field
        label={t("video.rows.fieldTitle")}
        value={draft.title ?? ""}
        required={false}
        placeholder={rowName({ ...draft, title: undefined }, t, libraryNames, collectionNames)}
        onChange={(value) => setDraft({ ...draft, title: value.trim() ? value.slice(0, 80) : undefined })}
      />
      <div className="modal-actions">
        <Button variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!ready} onClick={() => onDone(draft)}>{isNew ? t("video.rows.addDone") : t("common.done")}</Button>
      </div>
    </div>
  );
}
