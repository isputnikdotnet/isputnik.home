// The waveform strip shared by the recording dialog and the panel's player.
//
// Bars are amplitudes in 0..1, drawn right-aligned so a strip that is still
// filling (the microphone) grows leftwards from the right edge, and a finished
// one (a decoded file) spans the width. `cursor` (0..1) dims the bars past it,
// which is the playback position.

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

/** How many bars a full-width strip holds, for the canvas sizes used here. */
export const STRIP_BARS = Math.floor(760 / 7);

// Peaks of a saved recording: fetched and decoded once when it goes into the
// player. Same-origin, so the session cookie rides along. A format the browser
// cannot decode (it could not play it either) resolves to nothing, and the
// player falls back to a flat strip.
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
