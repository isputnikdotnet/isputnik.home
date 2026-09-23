import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

// Cut a frame out of a picture: drag the frame to move it, a corner to resize it
// (the aspect ratio holds), the wheel or +/- to zoom, the arrow keys to nudge.
// Detected faces are drawn as boxes; clicking one frames that face — which is
// what makes "the one person in a group photo" a single click.
//
// Frames are fractions of the picture AS SHOWN: `src` must be the upright image
// (a gallery preview is — orientation and rotation are baked in), and face boxes
// come in the same frame (catalog-asset.ts). `aspect` is width / height in pixels.

export interface CropFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropperFace {
  id: string;
  box: CropFrame;
  /** The name to show and announce; "" for a face nobody has named. */
  label: string;
}

/** Smallest frame side, as a fraction of the picture's shorter side. */
const MIN_SIDE = 0.05;
/** How much of the frame's height a picked face fills. */
const FACE_SHARE = 0.45;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** The largest frame of `aspect` that fits, centred. */
export function centredFrame(width: number, height: number, aspect: number): CropFrame {
  const wPx = Math.min(width, height * aspect);
  const hPx = wPx / aspect;
  return { x: (width - wPx) / 2 / width, y: (height - hPx) / 2 / height, w: wPx / width, h: hPx / height };
}

/** A frame around one face box: the face about 45% of its height, a little above
 *  the middle so hair and shoulders fit, kept on the picture. The server's
 *  frameAroundFace (familytree/portraits.ts) is the same for aspect 1. */
export function frameAroundBox(box: CropFrame, width: number, height: number, aspect = 1): CropFrame {
  let hPx = Math.max(box.h * height, (box.w * width) / aspect) / FACE_SHARE;
  let wPx = hPx * aspect;
  const fit = Math.min(1, width / wPx, height / hPx);
  hPx *= fit;
  wPx *= fit;
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  const left = clamp(cx - wPx / 2, 0, width - wPx);
  const top = clamp(cy - hPx * 0.42, 0, height - hPx);
  return { x: left / width, y: top / height, w: wPx / width, h: hPx / height };
}

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Drag =
  | { kind: "move"; startX: number; startY: number; frame: CropFrame }
  | { kind: "resize"; corner: Corner; frame: CropFrame };

export function ImageCropper({
  src,
  alt,
  aspect = 1,
  value,
  onChange,
  faces = [],
  initialFaceId = null
}: {
  src: string;
  alt: string;
  aspect?: number;
  value: CropFrame | null;
  onChange: (frame: CropFrame) => void;
  faces?: CropperFace[];
  /** The face to frame when the picture loads with no `value` yet. Without one,
   *  a lone face is framed, else the largest centred frame. */
  initialFaceId?: string | null;
}) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // First frame, once the picture's size is known.
  useEffect(() => {
    if (!size || value) return;
    const face = faces.find((f) => f.id === initialFaceId) ?? (faces.length === 1 ? faces[0] : null);
    onChange(face ? frameAroundBox(face.box, size.width, size.height, aspect) : centredFrame(size.width, size.height, aspect));
  }, [size, value, faces, initialFaceId, aspect, onChange]);

  // Frame sizes in the stage's pixels, where the aspect ratio holds.
  const stagePx = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  };

  const minSidePx = (rect: DOMRect) => Math.min(rect.width, rect.height) * MIN_SIDE;

  // Scale the frame about its centre by `factor`, kept on the picture.
  const zoom = (frame: CropFrame, factor: number) => {
    const rect = stagePx();
    if (!rect) return;
    let wPx = frame.w * rect.width * factor;
    wPx = clamp(wPx, minSidePx(rect), Math.min(rect.width, rect.height * aspect));
    const hPx = wPx / aspect;
    const cx = (frame.x + frame.w / 2) * rect.width;
    const cy = (frame.y + frame.h / 2) * rect.height;
    onChange({
      x: clamp(cx - wPx / 2, 0, rect.width - wPx) / rect.width,
      y: clamp(cy - hPx / 2, 0, rect.height - hPx) / rect.height,
      w: wPx / rect.width,
      h: hPx / rect.height
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const rect = stagePx();
    if (!rect) return;
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const f = drag.frame;
    if (drag.kind === "move") {
      const dx = (event.clientX - drag.startX) / rect.width;
      const dy = (event.clientY - drag.startY) / rect.height;
      onChange({ ...f, x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) });
      return;
    }
    // Resize from a corner: the opposite corner stays put.
    const east = drag.corner.endsWith("e");
    const south = drag.corner.startsWith("s");
    const ax = (east ? f.x : f.x + f.w) * rect.width;
    const ay = (south ? f.y : f.y + f.h) * rect.height;
    const room = Math.min(east ? rect.width - ax : ax, (south ? rect.height - ay : ay) * aspect);
    const wPx = clamp(Math.max(Math.abs(px - ax), Math.abs(py - ay) * aspect), minSidePx(rect), room);
    const hPx = wPx / aspect;
    onChange({
      x: (east ? ax : ax - wPx) / rect.width,
      y: (south ? ay : ay - hPx) / rect.height,
      w: wPx / rect.width,
      h: hPx / rect.height
    });
  };

  const startDrag = (event: React.PointerEvent, next: Drag) => {
    event.preventDefault();
    event.stopPropagation();
    // Keep the drag when the pointer leaves the stage. A pointer the browser
    // no longer tracks can't be captured; the drag still works inside the stage.
    try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* see above */ }
    setDrag(next);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!value) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]
    };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      onChange({ ...value, x: clamp(value.x + dx, 0, 1 - value.w), y: clamp(value.y + dy, 0, 1 - value.h) });
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(value, 1.05);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoom(value, 1 / 1.05);
    }
  };

  // The wheel zooms the frame; a passive React listener can't stop the page
  // scrolling under it, so this one is attached by hand.
  const valueRef = useRef(value);
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    valueRef.current = value;
    zoomRef.current = zoom;
  });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!valueRef.current) return;
      event.preventDefault();
      zoomRef.current(valueRef.current, event.deltaY > 0 ? 1.06 : 1 / 1.06);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const pct = (n: number) => `${n * 100}%`;

  return (
    <div
      ref={stageRef}
      className={`image-cropper${drag ? " is-dragging" : ""}`}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
      {value && (
        <div
          className="image-cropper-frame"
          style={{ left: pct(value.x), top: pct(value.y), width: pct(value.w), height: pct(value.h) }}
          tabIndex={0}
          role="group"
          aria-label={t("imageCropper.frameAria")}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => startDrag(event, { kind: "move", startX: event.clientX, startY: event.clientY, frame: value })}
        >
          {CORNERS.map((corner) => (
            <span
              key={corner}
              className={`image-cropper-handle is-${corner}`}
              aria-hidden="true"
              onPointerDown={(event) => startDrag(event, { kind: "resize", corner, frame: value })}
            />
          ))}
        </div>
      )}
      {size && faces.map((face) => (
        <Button
          key={face.id}
          variant="bare"
          className={`image-cropper-face${face.label ? "" : " is-unnamed"}`}
          style={{ left: pct(face.box.x), top: pct(face.box.y), width: pct(face.box.w), height: pct(face.box.h) }}
          title={face.label || t("imageCropper.unnamedFace")}
          aria-label={face.label ? t("imageCropper.frameFace", { name: face.label }) : t("imageCropper.frameUnnamedFace")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onChange(frameAroundBox(face.box, size.width, size.height, aspect))}
        />
      ))}
    </div>
  );
}

/** What a frame of the picture looks like, cut out — `round` for a portrait. */
export function CropPreview({ src, frame, size, round = false }: { src: string; frame: CropFrame | null; size: number; round?: boolean }) {
  const style: React.CSSProperties = { width: size, height: size };
  if (frame) {
    // The picture scaled so the frame fills the box, shifted so the frame is in it.
    const position = (start: number, extent: number) => (extent >= 1 ? 0 : (start / (1 - extent)) * 100);
    Object.assign(style, {
      backgroundImage: `url("${src}")`,
      backgroundSize: `${100 / frame.w}% ${100 / frame.h}%`,
      backgroundPosition: `${position(frame.x, frame.w)}% ${position(frame.y, frame.h)}%`
    });
  }
  return <div className={`image-cropper-preview${round ? " is-round" : ""}`} style={style} aria-hidden="true" />;
}
