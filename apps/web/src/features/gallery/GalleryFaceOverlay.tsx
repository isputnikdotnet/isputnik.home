import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import type { GalleryAsset, GalleryFace, GalleryPerson, GalleryPersonTag } from "./types";

// The faces recognition found, drawn over the photo in the lightbox.
//
// Boxes show in two ways: all of them while "Show faces" is on, or just one
// person's while their chip in the panel is hovered. Someone who can edit the
// photo clicks a box to say who that ONE face is, or that it isn't who it was
// grouped as. A group photo keeps everyone else where they were.
//
// The overlay is laid exactly over the <img> (which object-fit keeps at the
// photo's own aspect ratio), so a box's fractions are fractions of this layer.
export function GalleryFaceOverlay({
  image,
  faces,
  people,
  showAll,
  highlightPersonId,
  canEdit,
  onChanged
}: {
  image: HTMLImageElement | null;
  faces: GalleryFace[];
  // Who the photo says is in it. Anyone here without a box of their own was
  // named without one — in Review mode, usually, where a Photo Inbox has no
  // faces to point at yet — so they are who this face is most likely to be.
  people?: GalleryPersonTag[];
  showAll: boolean;
  highlightPersonId: string | null;
  canEdit: boolean;
  // The photo's detail after a face was named or rejected.
  onChanged: (asset: GalleryAsset) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!image) { setFrame(null); return; }
    const measure = () => {
      if (!image.offsetWidth || !image.offsetHeight) { setFrame(null); return; }
      setFrame({ left: image.offsetLeft, top: image.offsetTop, width: image.offsetWidth, height: image.offsetHeight });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(image);
    image.addEventListener("load", measure);
    return () => { observer?.disconnect(); image.removeEventListener("load", measure); };
  }, [image]);

  // Another photo, another set of faces: nothing stays open from the last one.
  const faceKey = faces.map((face) => face.id).join(",");
  useEffect(() => { setEditingId(null); setHoverFaceId(null); }, [faceKey]);

  if (!frame || faces.length === 0) return null;

  const nameOf = (face: GalleryFace) =>
    face.personName ? face.personName : t("gallery:faces.notNamed");
  const visible = faces.filter((face) =>
    showAll || face.id === editingId || face.id === hoverFaceId
    || (highlightPersonId != null && face.personId === highlightPersonId));
  if (visible.length === 0) return null;
  const editing = faces.find((face) => face.id === editingId) ?? null;
  // A person already drawn on a box is placed; the rest of the photo's people are
  // still looking for one, and this face is where they could go.
  const placed = new Set(faces.filter((face) => face.personId).map((face) => face.personId));
  const unplaced = (people ?? []).filter((person) => !placed.has(person.id));

  return (
    <div
      className="gallery-face-layer"
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
    >
      {visible.map((face) => {
        const style: CSSProperties = {
          left: `${face.box.x * 100}%`,
          top: `${face.box.y * 100}%`,
          width: `${face.box.w * 100}%`,
          height: `${face.box.h * 100}%`
        };
        const classes = [
          "gallery-face-box",
          face.personName ? "" : "is-unnamed",
          highlightPersonId != null && face.personId === highlightPersonId ? "is-highlighted" : "",
          face.id === editingId ? "is-editing" : ""
        ].filter(Boolean).join(" ");
        // The label sits under the box, or over it when the face is near the bottom.
        const label = (
          <span className={`gallery-face-label${face.box.y + face.box.h > 0.88 ? " is-above" : ""}`}>
            {nameOf(face)}
          </span>
        );
        return canEdit ? (
          <Button
            variant="bare"
            key={face.id}
            className={classes}
            style={style}
            onClick={() => setEditingId(face.id === editingId ? null : face.id)}
            onMouseEnter={() => setHoverFaceId(face.id)}
            onMouseLeave={() => setHoverFaceId((id) => (id === face.id ? null : id))}
            aria-label={t("gallery:faces.nameFaceAria", { name: nameOf(face) })}
            aria-expanded={face.id === editingId}
            title={nameOf(face)}
          >
            {label}
          </Button>
        ) : (
          <span key={face.id} className={classes} style={style} title={nameOf(face)}>
            {label}
          </span>
        );
      })}
      {canEdit && editing && (
        <FaceEditor
          key={editing.id}
          face={editing}
          unplaced={unplaced}
          onClose={() => setEditingId(null)}
          onChanged={(asset) => { setEditingId(null); onChanged(asset); }}
        />
      )}
    </div>
  );
}

// The small form beside a clicked face: who it is, or that it isn't who it was
// grouped as. Not a modal: the photo stays in view, since the face is the question.
//
// The photo's own unplaced people come first, as one tap each. Someone who said
// "Mum and Gran are in this one" in Review mode has already done the remembering;
// asking them to type it again over the face is asking twice.
function FaceEditor({
  face,
  unplaced,
  onClose,
  onChanged
}: {
  face: GalleryFace;
  unplaced: GalleryPersonTag[];
  onClose: () => void;
  onChanged: (asset: GalleryAsset) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const ref = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(face.personName ?? "");
  // A face in a group nobody has named: naming it names the group, by default.
  const unnamedGroup = face.personId != null && face.personName === "";
  const [wholeGroup, setWholeGroup] = useState(unnamedGroup);
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [busy, setBusy] = useState<"save" | "reject" | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ people: GalleryPerson[] }>("/api/library/gallery/people")
      .then((res) => { if (alive) setPeople(res.people.filter((person) => person.name)); })
      .catch(() => { /* suggestions are advisory */ });
    return () => { alive = false; };
  }, []);

  // A click anywhere else closes it, as long as nothing is being saved.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (busy || ref.current?.contains(target) || target?.closest(".gallery-face-box")) return;
      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [busy, onClose]);

  // `chosen` is one of the photo's own people, tapped instead of typed — same save,
  // no round trip through the text box.
  const save = async (chosen?: GalleryPersonTag) => {
    const typed = chosen?.name ?? name.trim();
    if (!typed || busy) return;
    const match = chosen ?? people.find((person) => person.name.toLowerCase() === typed.toLowerCase());
    if (match && match.id === face.personId && face.confirmed) { onClose(); return; }
    setBusy("save");
    setError(null);
    try {
      const body = { ...(match ? { personId: match.id } : { name: typed }), ...(unnamedGroup ? { wholeGroup } : {}) };
      const res = await api<{ asset: GalleryAsset }>(`/api/library/gallery/faces/${face.id}/person`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      onChanged(res.asset);
    } catch (err) {
      setError({ title: t("gallery:faces.saveError"), message: err instanceof Error ? err.message : "" });
      setBusy(null);
    }
  };

  const reject = async () => {
    if (busy) return;
    setBusy("reject");
    setError(null);
    try {
      const res = await api<{ asset: GalleryAsset }>(`/api/library/gallery/faces/${face.id}/person`, { method: "DELETE" });
      onChanged(res.asset);
    } catch (err) {
      setError({ title: t("gallery:faces.rejectError"), message: err instanceof Error ? err.message : "" });
      setBusy(null);
    }
  };

  // Opens under the face, or over it when the face sits low in the photo; and
  // hugs whichever side the face is on so it doesn't run off the edge.
  const style: CSSProperties = {
    ...(face.box.y + face.box.h > 0.6
      ? { bottom: `${(1 - face.box.y) * 100}%` }
      : { top: `${(face.box.y + face.box.h) * 100}%` }),
    ...(face.box.x + face.box.w / 2 > 0.5
      ? { right: `${Math.max(0, 1 - face.box.x - face.box.w) * 100}%` }
      : { left: `${face.box.x * 100}%` })
  };

  return (
    <form
      ref={ref}
      className="gallery-face-editor"
      style={style}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}
    >
      <div className="gallery-face-editor-head">
        {face.thumbUrl && <img src={face.thumbUrl} alt="" aria-hidden="true" />}
        <strong>{t("gallery:faces.whoIsThis")}</strong>
        <Button variant="icon" onClick={onClose} disabled={busy != null} aria-label={t("common:common.close")} title={t("common:common.close")}>
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
      <input
        list="gallery-face-people"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("gallery:common.name")}
        maxLength={120}
        aria-label={t("gallery:faces.whoIsThis")}
        autoFocus
      />
      <datalist id="gallery-face-people">
        {people.map((person) => <option key={person.id} value={person.name} />)}
      </datalist>
      {unplaced.length > 0 && (
        <div className="gallery-face-editor-suggest">
          <span className="gallery-face-editor-suggest-label">{t("gallery:faces.saidToBeHere")}</span>
          <div className="gallery-face-editor-chips">
            {unplaced.map((person) => (
              <Button
                variant="chip"
                key={person.id}
                className="gallery-face-editor-chip"
                onClick={() => void save(person)}
                disabled={busy != null}
                title={t("gallery:faces.thisFaceIs", { name: person.name })}
              >
                {person.name}
              </Button>
            ))}
          </div>
        </div>
      )}
      {unnamedGroup && (
        <label className="gallery-face-editor-check">
          <input type="checkbox" checked={wholeGroup} onChange={(event) => setWholeGroup(event.target.checked)} />
          <span>{t("gallery:faces.wholeGroup")}</span>
        </label>
      )}
      <div className="gallery-face-editor-actions">
        <Button variant="primary" compact type="submit" disabled={busy != null || !name.trim()}>
          {busy === "save" ? t("gallery:common.saving") : t("gallery:common.save")}
        </Button>
        {face.personId != null && (
          <Button variant="secondary" compact onClick={() => void reject()} disabled={busy != null}>
            {face.personName ? t("gallery:faces.notPerson", { name: face.personName }) : t("gallery:faces.notThisPerson")}
          </Button>
        )}
      </div>
      {error && <MessageBox tone="error" title={error.title}>{error.message}</MessageBox>}
    </form>
  );
}
