import { BookOpen, Heart, LayoutGrid, Library, Mic2, Pen } from "lucide-react";
import { followRoute } from "../../router";

export function AudiobookNav({ active }: { active: "books" | "saved" | "authors" | "narrators" | "series" | "categories" }) {
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
        className={active === "categories" ? "active" : ""}
        href="/audiobooks/categories"
        onClick={(e) => followRoute(e, "/audiobooks/categories")}
      >
        <LayoutGrid size={22} />
        Categories
      </a>
    </nav>
  );
}
