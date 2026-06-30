import { db } from "../../../../db.js";

// Face recognition is enabled per gallery library (key per library id), so a household
// can run it on, say, "Family" but not on a shared/landscape library. The clustering
// threshold stays global.
const LIB_PREFIX = "face_recognition.lib.";
const THRESHOLD_KEY = "face_recognition.threshold";
const K_KEY = "face_recognition.k";

// Edge floor for the mutual-kNN graph (min cosine for two faces to be candidate
// neighbours). The real grouping dial is K below; the floor just prunes the graph.
// Tuned for ArcFace, where different people score near 0 and same-person ~0.7.
export const DEFAULT_FACE_THRESHOLD = 0.3;
// "Grouping strength": each pair must be within the other's top-K neighbours to link.
// Lower K = purer but more fragmented groups; higher K = more consolidated but more
// risk of merging different people. 3 is the tested sweet spot for the ArcFace model.
export const DEFAULT_FACE_K = 3;

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

export function faceRecognitionEnabledForLibrary(libraryId: string): boolean {
  return readSetting(LIB_PREFIX + libraryId) === "true";
}

export function setFaceRecognitionEnabledForLibrary(libraryId: string, enabled: boolean, userId: string): void {
  writeSetting(LIB_PREFIX + libraryId, enabled ? "true" : "false", userId);
}

// Library ids with face recognition switched on.
export function enabledFaceLibraryIds(): string[] {
  return (db.prepare("SELECT key FROM app_settings WHERE key LIKE ? AND value = 'true'").all(`${LIB_PREFIX}%`) as { key: string }[])
    .map((r) => r.key.slice(LIB_PREFIX.length));
}

export function anyFaceLibraryEnabled(): boolean {
  return (db.prepare("SELECT 1 FROM app_settings WHERE key LIKE ? AND value = 'true' LIMIT 1").get(`${LIB_PREFIX}%`)) != null;
}

// Cosine-similarity cut-off for joining a face to an existing cluster. Tuned for the
// ArcFace 512-d descriptor; clamped to a sane range.
export function faceThreshold(): number {
  const raw = readSetting(THRESHOLD_KEY);
  const parsed = raw == null ? NaN : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_FACE_THRESHOLD;
  return Math.min(0.95, Math.max(0.2, parsed));
}

export function setFaceThreshold(value: number, userId: string): void {
  writeSetting(THRESHOLD_KEY, String(Math.min(0.95, Math.max(0.2, value))), userId);
}

export function faceGroupingK(): number {
  const raw = readSetting(K_KEY);
  const parsed = raw == null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FACE_K;
  return Math.min(8, Math.max(2, parsed));
}

export function setFaceGroupingK(value: number, userId: string): void {
  writeSetting(K_KEY, String(Math.min(8, Math.max(2, Math.round(value)))), userId);
}
