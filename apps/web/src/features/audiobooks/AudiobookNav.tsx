import { useEffect, useState } from "react";
import { BookOpen, Heart, Library, Mic2, Pen, Share2 } from "lucide-react";
import { api } from "../../api";
import { followRoute } from "../../router";
import { CategoryIcon } from "./categoryIcons";
import type { LibrarySection } from "./types";

export function AudiobookNav({
  active,
  activeSectionId
}: {
  active?: "books" | "saved" | "shared" | "authors" | "narrators" | "series" | "categories";
  activeSectionId?: string;
}) {
  const [sections, setSections] = useState<LibrarySection[]>([]);

  useEffect(() => {
    api<{ sections: LibrarySection[] }>("/api/library/sections")
      .then((payload) => setSections(payload.sections))
      .catch(() => {});
  }, []);

  return (
    <nav className="side-nav">
      <a
        className={active === "books" ? "active" : ""}
        href="/audiobooks"
        onClick={(e) => followRoute(e, "/audiobooks")}
      >
        <BookOpen size={22} />
        Books
      </a>
      <a
        className={active === "saved" ? "active" : ""}
        href="/audiobooks/saved"
        onClick={(e) => followRoute(e, "/audiobooks/saved")}
      >
        <Heart size={22} />
        My List
      </a>
      <a
        className={active === "shared" ? "active" : ""}
        href="/audiobooks/shared"
        onClick={(e) => followRoute(e, "/audiobooks/shared")}
      >
        <Share2 size={22} />
        Shared
      </a>
      <a
        className={active === "authors" ? "active" : ""}
        href="/audiobooks/authors"
        onClick={(e) => followRoute(e, "/audiobooks/authors")}
      >
        <Pen size={22} />
        Authors
      </a>
      <a
        className={active === "narrators" ? "active" : ""}
        href="/audiobooks/narrators"
        onClick={(e) => followRoute(e, "/audiobooks/narrators")}
      >
        <Mic2 size={22} />
        Narrators
      </a>
      <a
        className={active === "series" ? "active" : ""}
        href="/audiobooks/series"
        onClick={(e) => followRoute(e, "/audiobooks/series")}
      >
        <Library size={22} />
        Series
      </a>
      {sections.length > 0 && <div className="side-nav-divider" aria-hidden="true" />}
      {sections.map((section) => (
        <a
          key={section.id}
          className={activeSectionId === section.id ? "active" : ""}
          href={`/audiobooks/sections/${section.id}`}
          onClick={(e) => followRoute(e, `/audiobooks/sections/${section.id}`)}
        >
          <CategoryIcon icon={section.icon} size={22} />
          {section.name}
        </a>
      ))}
    </nav>
  );
}
