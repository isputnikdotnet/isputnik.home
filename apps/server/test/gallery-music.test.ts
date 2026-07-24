import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import {
  createUserTrack,
  deleteMusicTrack,
  getMusicTrack,
  listMusicTracks,
  musicTempDir,
  removeBuiltinMusic
} from "../src/modules/library/gallery/music.js";
import { createSlideshow, getSlideshow, updateSlideshow } from "../src/modules/library/gallery/slideshows.js";
import { resetDb, makeUser } from "./helpers/seed.js";

const uploader = { id: "uploader", role: "member" };
const other = { id: "other", role: "member" };
const admin = { id: "boss", role: "admin" };
let store = "";

// Insert a built-in bed row directly (real ones are ffmpeg-synthesised at startup;
// the DB/CRUD logic under test doesn't need the audio file).
function seedBuiltinRow(id: string, title: string) {
  db.prepare(
    "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds) VALUES (?, ?, 'Built-in', 1, ?, 24)"
  ).run(id, title, `music/bu/il/${id}.mp3`);
}

// A user upload as the route would hand it to createUserTrack: a temp file already
// inside the store's music dir.
async function uploadFake(user: { id: string }, filename: string, ext: string) {
  const tmp = path.join(musicTempDir(), `.upload-${Math.random().toString(16).slice(2)}.${ext}`);
  fs.writeFileSync(tmp, Buffer.from("not-real-audio-bytes"));
  return createUserTrack(user, tmp, filename, ext);
}

beforeEach(() => {
  resetDb();
  makeUser("uploader");
  makeUser("other");
  makeUser("boss", "admin");
  store = fs.mkdtempSync(path.join(os.tmpdir(), "music-store-"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, store);
});

afterEach(() => {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("music uploads", () => {
  it("stores the file under the music bucket and records a user track", async () => {
    const track = await uploadFake(uploader, "Beach Day.mp3", "mp3");
    expect(track.builtin).toBe(false);
    expect(track.title).toBe("Beach Day");
    expect(track.url).toBe(`/api/library/gallery/music/${track.id}/stream`);

    const row = getMusicTrack(track.id)!;
    expect(row.uploaded_by).toBe("uploader");
    expect(fs.existsSync(path.join(store, row.storage_key))).toBe(true);
  });
});

describe("music listing", () => {
  it("lists only user uploads (no built-in beds)", async () => {
    await uploadFake(uploader, "Mine.mp3", "mp3");
    const tracks = listMusicTracks();
    expect(tracks.every((t) => !t.builtin)).toBe(true);
    expect(tracks.some((t) => t.title === "Mine")).toBe(true);
  });
});

describe("retiring built-in beds", () => {
  it("purges built-in rows (and files) but leaves user uploads", async () => {
    const bedPath = path.join(store, "music", "bu", "il", "builtinbedwarm001.flac");
    fs.mkdirSync(path.dirname(bedPath), { recursive: true });
    fs.writeFileSync(bedPath, Buffer.from("fake"));
    db.prepare(
      "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds) VALUES (?, 'Warm Daylight', 'Built-in', 1, ?, 24)"
    ).run("builtinbedwarm001", "music/bu/il/builtinbedwarm001.flac");
    const mine = await uploadFake(uploader, "Mine.mp3", "mp3");

    removeBuiltinMusic();

    expect(getMusicTrack("builtinbedwarm001")).toBeUndefined();
    expect(fs.existsSync(bedPath)).toBe(false);
    expect(getMusicTrack(mine.id)).toBeDefined();
    const listed = listMusicTracks();
    expect(listed.every((t) => !t.builtin)).toBe(true);
    expect(listed.some((t) => t.id === mine.id)).toBe(true);
  });

  it("degrades a slideshow that pointed at a built-in bed to silent", () => {
    seedBuiltinRow("builtinbedcalm001", "Quiet Evening");
    const slideshow = createSlideshow(uploader, "Trip");
    updateSlideshow(slideshow.id, { musicTrackId: "builtinbedcalm001" });
    expect(getSlideshow(slideshow.id)!.music_track_id).toBe("builtinbedcalm001");

    removeBuiltinMusic();
    expect(getSlideshow(slideshow.id)!.music_track_id).toBeNull();
  });
});

describe("music deletion", () => {
  it("refuses built-in beds", () => {
    seedBuiltinRow("builtinbedcalm001", "Quiet Evening");
    expect(deleteMusicTrack("builtinbedcalm001", admin)).toBe("builtin");
    expect(getMusicTrack("builtinbedcalm001")).toBeDefined();
  });

  it("lets only the uploader or an admin delete a user track", async () => {
    const track = await uploadFake(uploader, "Mine.mp3", "mp3");
    const filePath = path.join(store, getMusicTrack(track.id)!.storage_key);
    expect(deleteMusicTrack(track.id, other)).toBe("forbidden");
    expect(deleteMusicTrack(track.id, uploader)).toBe("ok");
    expect(getMusicTrack(track.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false); // file removed too
  });

  it("reports notfound for an unknown id", () => {
    expect(deleteMusicTrack("nope", admin)).toBe("notfound");
  });
});

describe("slideshow ↔ music link", () => {
  it("sets, clears, and degrades to silent when the track is deleted", async () => {
    const track = await uploadFake(uploader, "Bed.mp3", "mp3");
    const slideshow = createSlideshow(uploader, "Trip");

    updateSlideshow(slideshow.id, { musicTrackId: track.id });
    expect(getSlideshow(slideshow.id)!.music_track_id).toBe(track.id);

    // undefined leaves it alone; null clears it.
    updateSlideshow(slideshow.id, { name: "Trip 2" });
    expect(getSlideshow(slideshow.id)!.music_track_id).toBe(track.id);
    updateSlideshow(slideshow.id, { musicTrackId: null });
    expect(getSlideshow(slideshow.id)!.music_track_id).toBeNull();

    // Re-link, then delete the track: the FK SET NULL degrades the slideshow to silent.
    updateSlideshow(slideshow.id, { musicTrackId: track.id });
    expect(deleteMusicTrack(track.id, uploader)).toBe("ok");
    expect(getSlideshow(slideshow.id)!.music_track_id).toBeNull();
  });
});
