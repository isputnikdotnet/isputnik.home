import { BookOpen, Heart, Library, Mic2, Pen, Tag } from "lucide-react";
import { followRoute } from "../../router";

export function AudiobookNav({ active }: { active: "books" | "saved" | "authors" | "narrators" | "series" | "genres" }) {
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
      <a
        className={active === "genres" ? "active" : ""}
        href="/audiobooks/genres"
        onClick={(e) => followRoute(e, "/audiobooks/genres")}
      >
        <Tag size={22} />
        Genres
      </a>
    </nav>
  );
}
