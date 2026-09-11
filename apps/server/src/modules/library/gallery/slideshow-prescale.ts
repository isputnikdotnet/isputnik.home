import sharp from "sharp";
import { HEIGHT, WIDTH, type Segment } from "./slideshow-segments.js";

// ── Feeding ffmpeg pictures the size of the movie ────────────────────────────
//
// Every photo in a slideshow becomes its own ffmpeg input, and every input holds
// decoded frames AT THE SOURCE'S RESOLUTION for as long as the render runs. The
// movie is 1920x1080 whatever goes in, so a 40-megapixel original is scaled down
// inside ffmpeg anyway — after paying for it. Measured over 63 photos: ~1.9 GB from
// 1080p sources, ~3.9 GB from 12 MP phone photos, ~17 GB from a modern camera's,
// which is a self-hosted server falling over rather than rendering a movie.
//
// So the scaling happens here first, with sharp, ONE PHOTO AT A TIME — bounded
// memory by construction — and ffmpeg is handed pictures already the size it wants.
// It also cuts the work: scaling the originals was most of the render's CPU, and
// libvips does it far faster than the filtergraph.
//
// Videos are left alone: a video decodes frame by frame, so its cost doesn't grow
// with the length of the slideshow the way a still's does.
const SCALED_QUALITY = 90;

async function scalePhotoForRender(source: string, destination: string, rotation: number): Promise<boolean> {
  try {
    // rotate() applies the EXIF orientation and a second rotate(angle) adds the
    // user's own, exactly as the gallery's thumbnails do (media.ts) — so the movie
    // shows photos the way the gallery does, upright, which ffmpeg never did.
    const image = sharp(source, { failOn: "none" }).rotate();
    await (rotation ? image.rotate(rotation) : image)
      .resize(WIDTH, HEIGHT, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: SCALED_QUALITY })
      .toFile(destination);
    return true;
  } catch {
    return false; // unreadable or an odd format: fall back to the original, as before
  }
}

// Replace each photo's path with a render-sized copy. A photo that can't be scaled
// keeps its original path — one heavy input is survivable, a failed render is not.
export async function prescaleSegments(
  segments: Segment[],
  rotations: number[],
  tempPathFor: (index: number) => string,
  onScaled?: (done: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<{ segments: Segment[]; written: string[] }> {
  const written: string[] = [];
  const out: Segment[] = [];
  const photos = segments.filter((segment) => !segment.isVideo).length;
  let done = 0;

  for (const [index, segment] of segments.entries()) {
    if (isCancelled()) break;
    if (segment.isVideo) { out.push(segment); continue; }
    const destination = tempPathFor(index);
    if (await scalePhotoForRender(segment.file, destination, rotations[index] ?? 0)) {
      written.push(destination);
      out.push({ ...segment, file: destination });
    } else {
      out.push(segment);
    }
    done += 1;
    onScaled?.(done, photos);
  }

  // Cancelled part-way: hand back what we have plus the untouched remainder, so the
  // caller still sees every segment (and its cleanup, every file written).
  for (let i = out.length; i < segments.length; i += 1) out.push(segments[i]);
  return { segments: out, written };
}
