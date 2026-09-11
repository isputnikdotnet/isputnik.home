import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, Combine, Image as ImageIcon, Pencil, SquareCheck, Trash2, Users, X } from "lucide-react";
import { Button } from "../../../shared/Button";
import { SelectField } from "../../../shared/SelectField";
import { AssetTile, PersonAvatar, type LightboxSource } from "../AssetTile";
import type { GalleryAsset, GalleryPerson } from "../types";
import type { useGalleryPeople } from "../useGalleryPeople";
import { PEOPLE_PAGE } from "./gallery-page-model";

// People: the grid of everyone the face scan found, or — with one open — their
// photos, with rename / merge / move-photos / cover / delete for curators.
export function PeopleView({
  peopleState,
  shownPeople,
  nameTerm,
  loading,
  isAdmin,
  canCuratePeople,
  setNotice,
  toggleAssetLike,
  openLightbox
}: {
  peopleState: ReturnType<typeof useGalleryPeople>;
  /** `people` narrowed by the header's name filter. */
  shownPeople: GalleryPerson[];
  nameTerm: string;
  loading: boolean;
  isAdmin: boolean;
  canCuratePeople: boolean;
  setNotice: (message: string) => void;
  toggleAssetLike: (asset: GalleryAsset, next: boolean) => Promise<void>;
  openLightbox: (source: LightboxSource, index: number) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const {
    people, selectedPerson, setSelectedPerson, personAssets, personTotal,
    renameValue, setRenameValue, mergeOpen, setMergeOpen,
    setPersonCoverPickerOpen, setPersonDeleteOpen, personPick, setPersonPick,
    moveNewName, setMoveNewName, movingPhotos,
    showSmallGroups, setShowSmallGroups,
    visiblePeople, setVisiblePeople, visibleSmall, setVisibleSmall,
    anyFaceEnabled, loadPeople, openPerson, submitRename,
    confirmMerge, removeFromPerson, togglePersonPick, movePickedPhotos
  } = peopleState;

  if (selectedPerson) {
    const personCoverUrl = people.find((p) => p.id === selectedPerson.id)?.coverUrl ?? null;
    return (
      <>
        {/* Same idea as the album/slideshow detail's topbar: Back
            plus every action this person offers, icon-only. */}
        <div className="slideshow-detail-topbar">
          <Button
            variant="icon"
            title={t("gallery:page.back.people")}
            aria-label={t("gallery:page.back.people")}
            onClick={() => { setSelectedPerson(null); setRenameValue(null); setMergeOpen(false); void loadPeople(); }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Button>
          {canCuratePeople && (
            <>
              <span className="library-toolbar-divider" aria-hidden="true" />
              {people.length > 1 && (
                <Button variant="icon" title={t("gallery:people.mergeAllTitle")} aria-label={t("gallery:people.mergeAllTitle")} onClick={() => setMergeOpen((v) => !v)}>
                  <Combine size={18} aria-hidden="true" />
                </Button>
              )}
              <Button
                variant="icon"
                title={personPick ? t("gallery:people.cancelSelection") : t("gallery:people.pickPhotos")}
                aria-label={personPick ? t("gallery:people.cancelSelection") : t("gallery:people.pickPhotos")}
                onClick={() => { setPersonPick(personPick ? null : new Set()); setMoveNewName(null); setMergeOpen(false); }}
              >
                <SquareCheck size={18} aria-hidden="true" />
              </Button>
              {personAssets.length > 0 && (
                <Button variant="icon" title={t("gallery:common.setCoverPhoto")} aria-label={t("gallery:common.setCoverPhoto")} onClick={() => { setNotice(""); setPersonCoverPickerOpen(true); }}>
                  <ImageIcon size={18} aria-hidden="true" />
                </Button>
              )}
              <Button variant="icon" danger title={t("gallery:common.deleteWord")} aria-label={t("gallery:common.deleteWord")} onClick={() => setPersonDeleteOpen(true)}>
                <Trash2 size={18} aria-hidden="true" />
              </Button>
            </>
          )}
        </div>

        <div className="gallery-album-header">
          <span className="gallery-person-avatar">
            <PersonAvatar url={personCoverUrl} />
          </span>
          <div className="gallery-album-heading">
            {renameValue == null ? (
              <div className="gallery-title-row">
                <h2 className={selectedPerson.name ? undefined : "gallery-person-unnamed"}>{selectedPerson.name || t("gallery:common.unnamed")}</h2>
                {canCuratePeople && (
                  <Button
                    variant="icon"
                    title={selectedPerson.name ? t("gallery:common.rename") : t("gallery:people.namePersonTitle")}
                    aria-label={selectedPerson.name ? t("gallery:common.rename") : t("gallery:people.namePersonTitle")}
                    onClick={() => setRenameValue(selectedPerson.name)}
                  >
                    <Pencil size={18} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : (
              <form className="gallery-person-rename" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder={t("gallery:common.name")} autoFocus maxLength={120} />
                <button type="submit" className="primary-button compact-button" disabled={!renameValue.trim()}>{t("gallery:common.save")}</button>
                <button type="button" className="icon-button" onClick={() => setRenameValue(null)} aria-label={t("common:common.cancel")}><X size={14} aria-hidden="true" /></button>
              </form>
            )}
            <p className="gallery-album-sub">
              {t("gallery:common.counts.photo", { count: personTotal })}
            </p>
          </div>
        </div>

        {mergeOpen && (
          <div className="gallery-merge-panel">
            <Trans i18nKey="people.mergeInto" ns="gallery" values={{ name: selectedPerson.name || t("gallery:common.unnamed") }} components={{ bold: <strong /> }} />
            <SelectField
              compact
              hideLabel
              label={t("gallery:people.choosePersonOption")}
              value=""
              onChange={(value: string) => { if (value) void confirmMerge(value); }}
              options={[
                { value: "", label: t("gallery:people.choosePersonOption"), disabled: true },
                ...people.filter((p) => p.id !== selectedPerson.id).map((p) => ({
                  value: p.id, label: `${p.name || t("gallery:common.unnamed")} (${p.faceCount})`
                }))
              ]}
            />
            <button type="button" className="icon-button" onClick={() => setMergeOpen(false)} aria-label={t("common:common.cancel")}><X size={14} aria-hidden="true" /></button>
          </div>
        )}

        {personPick && (
          <div className="gallery-move-panel">
            <span className="audiobook-bulk-count">
              {t("gallery:common.counts.selected", { count: personPick.size })}
            </span>
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => setPersonPick(new Set(personAssets.map((asset) => asset.id)))}
              disabled={personAssets.length === 0 || movingPhotos}
            >
              {t("gallery:people.selectAllLoaded")}
            </button>
            {moveNewName == null ? (
              <SelectField
                compact
                hideLabel
                className="gallery-move-target"
                label={t("gallery:people.moveToPlaceholder")}
                value=""
                disabled={personPick.size === 0 || movingPhotos}
                onChange={(value: string) => {
                  if (value === "__new") setMoveNewName("");
                  else if (value) void movePickedPhotos({ intoId: value });
                }}
                options={[
                  { value: "", label: movingPhotos ? t("gallery:common.moving") : t("gallery:people.moveToPlaceholder"), disabled: true },
                  ...people.filter((p) => p.id !== selectedPerson.id).map((p) => ({
                    value: p.id, label: `${p.name || t("gallery:common.unnamed")} (${p.faceCount})`
                  })),
                  { value: "__new", label: t("gallery:people.newPersonOption") }
                ]}
              />
            ) : (
              <form
                className="gallery-person-rename"
                onSubmit={(event) => { event.preventDefault(); void movePickedPhotos({ name: moveNewName.trim() }); }}
              >
                <input
                  value={moveNewName}
                  onChange={(event) => setMoveNewName(event.target.value)}
                  placeholder={t("gallery:people.newPersonNamePlaceholder")}
                  autoFocus
                  maxLength={120}
                />
                <button type="submit" className="primary-button compact-button" disabled={!moveNewName.trim() || movingPhotos}>
                  {movingPhotos ? t("gallery:common.moving") : t("gallery:people.moveButton")}
                </button>
                <button type="button" className="icon-button" onClick={() => setMoveNewName(null)} aria-label={t("common:common.cancel")}>
                  <X size={14} aria-hidden="true" />
                </button>
              </form>
            )}
            <span className="muted gallery-move-hint">
              {t("gallery:people.moveHint")}
            </span>
          </div>
        )}

        <div className="gallery-grid">
          {personAssets.map((asset, index) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              onOpen={() => openLightbox("person", index)}
              selectionMode={personPick != null}
              selected={personPick?.has(asset.id) ?? false}
              onToggleSelect={() => togglePersonPick(asset.id)}
              onToggleLike={(next) => void toggleAssetLike(asset, next)}
              onRemove={canCuratePeople && !personPick ? () => void removeFromPerson(asset.id) : undefined}
            />
          ))}
        </div>
        {!loading && personAssets.length === 0 && (
          <p className="management-empty">{t("gallery:people.emptyNoPhotos")}</p>
        )}
        {personAssets.length < personTotal && (
          <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
            <button type="button" className="secondary-button" onClick={() => void openPerson(selectedPerson, personAssets.length)} disabled={loading}>
              {loading ? t("gallery:common.loading") : t("gallery:common.loadMore")}
            </button>
          </div>
        )}
      </>
    );
  }

  // Keep named people and multi-photo groups up front; tuck unnamed
  // single-photo groups into a collapsible "Small groups" section so a
  // long tail of singletons doesn't bury the people that matter.
  // Off shownPeople, so the search box narrows both sections.
  const main = shownPeople.filter((p) => p.name || p.faceCount > 1);
  const small = shownPeople.filter((p) => !p.name && p.faceCount <= 1);
  const card = (person: GalleryPerson) => (
    <button key={person.id} type="button" className="gallery-person-card" onClick={() => void openPerson(person)}>
      <span className="gallery-person-avatar">
        <PersonAvatar url={person.coverUrl} />
      </span>
      <strong className={person.name ? undefined : "gallery-person-unnamed"}>{person.name || t("gallery:common.unnamed")}</strong>
      <small>{t("gallery:common.counts.photo", { count: person.faceCount })}</small>
    </button>
  );
  const showMore = (onClick: () => void) => (
    <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
      <button type="button" className="secondary-button" onClick={onClick}>{t("gallery:people.showMore")}</button>
    </div>
  );

  return (
    <>
      {main.length > 0 && <div className="gallery-people-grid">{main.slice(0, visiblePeople).map(card)}</div>}
      {main.length > visiblePeople && showMore(() => setVisiblePeople((n) => n + PEOPLE_PAGE))}
      {small.length > 0 && (
        <div className="gallery-small-groups">
          <button type="button" className="gallery-small-toggle" onClick={() => setShowSmallGroups((v) => !v)}>
            <ChevronRight size={15} className={showSmallGroups ? "rotated" : ""} aria-hidden="true" />
            {t("gallery:people.smallGroupsToggle", { count: small.length })}
          </button>
          {showSmallGroups && (
            <>
              <div className="gallery-people-grid">{small.slice(0, visibleSmall).map(card)}</div>
              {small.length > visibleSmall && showMore(() => setVisibleSmall((n) => n + PEOPLE_PAGE))}
            </>
          )}
        </div>
      )}
      {!loading && shownPeople.length === 0 && nameTerm && (
        <div className="empty-state library-empty">
          <Users size={48} aria-hidden="true" />
          <h2>{t("gallery:people.noMatchTitle")}</h2>
          <p className="muted">{t("gallery:people.noMatchBody")}</p>
        </div>
      )}
      {!loading && people.length === 0 && (
        <div className="empty-state library-empty">
          <Users size={48} aria-hidden="true" />
          <h2>{t("gallery:people.emptyTitle")}</h2>
          <p className="muted">
            {isAdmin && !anyFaceEnabled
              ? t("gallery:people.emptyBodyAdmin")
              : t("gallery:people.emptyBodyDefault")}
          </p>
        </div>
      )}
    </>
  );
}
