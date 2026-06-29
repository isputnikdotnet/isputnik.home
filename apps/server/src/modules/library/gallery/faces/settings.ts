import { db } from "../../../../db.js";

const ENABLED_KEY = "face_recognition.enabled";
const THRESHOLD_KEY = "face_recognition.threshold";

export const DEFAULT_FACE_THRESHOLD = 0.5;

function readSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string, userId: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(key, value, userId);
}

export function faceRecognitionEnabled(): boolean {
  return readSetting(ENABLED_KEY) === "true";
}

// Cosine-similarity cut-off for joining a face to an existing cluster. Tuned for the
// faceres 1024-d descriptor; clamped to a sane range.
export function faceThreshold(): number {
  const raw = readSetting(THRESHOLD_KEY);
  const parsed = raw == null ? NaN : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FACE_THRESHOLD;
  return Math.min(0.95, Math.max(0.2, parsed));
}

export function setFaceRecognitionEnabled(enabled: boolean, userId: string): void {
  writeSetting(ENABLED_KEY, enabled ? "true" : "false", userId);
}

export function setFaceThreshold(value: number, userId: string): void {
  writeSetting(THRESHOLD_KEY, String(Math.min(0.95, Math.max(0.2, value))), userId);
}
