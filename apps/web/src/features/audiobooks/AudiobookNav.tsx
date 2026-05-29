import { followRoute } from "../../router";

export function AudiobookNav({ active }: { active: "books" | "authors" | "narrators" }) {
  return (
    <nav className="side-nav">
      <p className="side-nav-label">Audiobooks</p>
      <a
        className={active === "books" ? "active" : ""}
        href="/audiobooks"
        onClick={(e) => followRoute(e, "/audiobooks")}
      >
        Books
      </a>
      <a
        className={active === "authors" ? "active" : ""}
        href="/audiobooks/authors"
        onClick={(e) => followRoute(e, "/audiobooks/authors")}
      >
        Authors
      </a>
      <a
        className={active === "narrators" ? "active" : ""}
        href="/audiobooks/narrators"
        onClick={(e) => followRoute(e, "/audiobooks/narrators")}
      >
        Narrators
      </a>
    </nav>
  );
}
