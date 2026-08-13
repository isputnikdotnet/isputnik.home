import { useEffect, useState } from "react";
import { Shapes } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { SectionNav } from "../../shared/SectionNav";
import { SortMenu } from "../../shared/SortMenu";
import { CategoryIcon, categoryTint } from "./categoryIcons";
import { sectionFromQuery, sectionNavProps } from "./sectionNavItems";
import type { CategorySummary } from "./types";

export function CategoryListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  // "shelf" is the curated order the server returns (categories.sort_order) — the
  // one a browsing eye expects, so it stays the default.
  const [sort, setSort] = useState<"shelf" | "name" | "books">("shelf");
  const section = sectionFromQuery();

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load categories"));
  }, []);

  const term = search.trim().toLowerCase();
  const shown = categories
    .filter((category) => !term || category.name.toLowerCase().includes(term))
    .slice()
    .sort((a, b) => {
      if (sort === "books") return b.bookCount - a.bookCount;
      if (sort === "name") return a.name.localeCompare(b.name);
      return 0; // the payload already arrives in shelf order
    });

  return (
    <DashboardShell
      active={section?.active ?? "categories"}
      user={user}
      logout={logout}
      sideNav={section && <SectionNav {...sectionNavProps(section)} activeKey="categories" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title="Categories"
          subtitle={`${shown.length} ${shown.length === 1 ? "category" : "categories"}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search categories..."
        />

        {error && <MessageBox tone="error" title="Categories error">{error}</MessageBox>}

        {/* Same toolbar as its sibling browse pages, with only the control this one
            can use: the taxonomy is a fixed, curated shelf of a few dozen names —
            there is no library to scope it to, and an A–Z strip over a list that
            fits on one screen would filter nothing anyone couldn't already see. */}
        {categories.length > 0 && (
          <LibraryPageToolbar
            tools={
              <SortMenu
                presentation="labelled"
                value={sort}
                ariaLabel="Sort categories"
                onChange={setSort}
                options={[
                  { value: "shelf", label: "Shelf order" },
                  { value: "name", label: "Name (A–Z)" },
                  { value: "books", label: "Most books" }
                ]}
              />
            }
          />
        )}

        {shown.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <Shapes size={48} aria-hidden="true" />
            <h2>No categories{term ? " match" : " yet"}</h2>
          </div>
        ) : (
        <div className="category-grid">
          {shown.map((category) => (
            <button
              key={category.key}
              className={`category-tile category-tint-${categoryTint(category.key)}`}
              onClick={() => navigate(`/categories/${category.key}${section ? `?section=${section.active}` : ""}`)}
            >
              <CategoryIcon icon={category.icon} size={26} />
              <strong>{category.name}</strong>
              <span>{category.bookCount} {category.bookCount === 1 ? "book" : "books"}</span>
            </button>
          ))}
        </div>
        )}
      </section>
    </DashboardShell>
  );
}
