// The sections a profile leaves out, refused on the server as well as hidden on
// the screen: a TV in Kids can't reach a family-tree route by typing its address.
// Matched by route prefix — enough to fence what the screens use. Books are shared
// by audiobooks and ebooks, so their routes close only when both sections do.
import type { FastifyRequest } from "fastify";
import type { SectionKey, Sections } from "../../core/sections.js";
import { currentProfileOf, effectiveSections } from "./store.js";

/** [prefix, the sections of which any one keeps it open]. */
const FENCES: [string, SectionKey[]][] = [
  ["/video", ["video"]],
  ["/api/video", ["video"]],
  ["/api/library/video-", ["video"]],
  ["/games", ["games"]],
  ["/api/games", ["games"]],
  ["/api/library/gallery", ["gallery"]],
  ["/api/family-tree", ["familyTree"]],
  ["/api/stories", ["stories"]],
  ["/api/library/audiobook", ["audiobooks"]],
  ["/api/library/ebook", ["ebooks"]],
  ["/api/library/books", ["audiobooks", "ebooks"]],
  ["/api/library/series", ["audiobooks", "ebooks"]],
  ["/api/library/works", ["audiobooks", "ebooks"]]
];

function matches(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  // "/video" fences "/video/…" but not "/videos": a prefix that ends a word must
  // end a path segment. One ending in "-" or a word stem ("audiobook") is a stem.
  if (prefix.endsWith("-") || prefix.endsWith("audiobook") || prefix.endsWith("ebook") || prefix.endsWith("gallery")) return true;
  const next = path.charAt(prefix.length);
  return next === "" || next === "/" || next === "?";
}

export function fencedSection(path: string, sections: Sections): SectionKey | null {
  for (const [prefix, keys] of FENCES) {
    if (matches(path, prefix) && !keys.some((key) => sections[key])) return keys[0]!;
  }
  return null;
}

/** The session guard (core/session-guards.ts). */
export function profileFence(request: FastifyRequest): string | null {
  const profile = currentProfileOf(request);
  if (!profile?.sections) return null;
  const section = fencedSection(request.url, effectiveSections(profile));
  return section ? `This profile can't open ${section}.` : null;
}
