// Shared by the recording dialog and the audio player (docs/lightbox-panel.md,
// phases 2 and 3): the waveform strip, seconds formatting, and the one check
// for whether this browser can record at all.

/** "1:05" from seconds; "" when unknown. */
export function formatSeconds(total: number | null | undefined): string {
  if (total == null || !Number.isFinite(total)) return "";
  const s = Math.round(total);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** True where MediaRecorder can run: a secure context with a microphone API. */
export function recordingSupported(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext
    && typeof window.MediaRecorder !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

// Bars are amplitudes in 0..1, drawn right-aligned so a strip that is still
// filling (the microphone) grows leftwards from the right edge, and a finished
// one (a decoded file) spans the width. `cursor` (0..1) dims the bars past it,
// which is the playback position. Colours are the strip's own: it always sits
// on a dark ground (the strip paints one), whatever the page theme is.
export function drawBars(canvas: HTMLCanvasElement, amps: number[], cursor: number | null) {
  const x = canvas.getContext("2d");
  if (!x) return;
  const w = canvas.width;
  const h = canvas.height;
  const bar = 4;
  const gap = 3;
  x.clearRect(0, 0, w, h);
  const n = Math.floor(w / (bar + gap));
  const slice = amps.length > 0 ? amps.slice(-n) : Array.from({ length: n }, () => 0);
  const offset = w - slice.length * (bar + gap);
  slice.forEach((a, i) => {
    const bh = Math.max(4, Math.min(1, a * 2.2) * h);
    const cx = offset + i * (bar + gap);
    const past = cursor == null || i / slice.length <= cursor;
    x.fillStyle = amps.length === 0 ? "rgba(255, 255, 255, 0.28)" : past ? "#f3f1ec" : "rgba(255, 255, 255, 0.22)";
    x.beginPath();
    x.roundRect(cx, (h - bh) / 2, bar, bh, 2);
    x.fill();
  });
}

/** The canvas the strips draw on, and how many bars a full one holds. */
export const STRIP_WIDTH = 760;
export const STRIP_HEIGHT = 144;
export const STRIP_BARS = Math.floor(STRIP_WIDTH / 7);

// Peaks of a saved recording (or a blob: URL of a fresh take): fetched and
// decoded once when it goes into the player. Same-origin, so the session
// cookie rides along. A format the browser cannot decode (it could not play it
// either) resolves to nothing, and the player falls back to a flat strip.
export async function peaksFromUrl(url: string, bars = STRIP_BARS): Promise<number[] | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(bytes);
      const data = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(data.length / bars));
      const out: number[] = [];
      for (let b = 0; b < bars; b++) {
        let sum = 0;
        const start = b * per;
        const end = Math.min(data.length, start + per);
        for (let i = start; i < end; i++) sum += data[i] * data[i];
        out.push(Math.sqrt(sum / Math.max(1, end - start)));
      }
      // Normalise so a quiet voice still draws as a voice.
      const peak = Math.max(...out, 0.001);
      return out.map((v) => Math.min(1, (v / peak) * 0.45));
    } finally {
      void context.close().catch(() => { /* already closed */ });
    }
  } catch {
    return null;
  }
}
