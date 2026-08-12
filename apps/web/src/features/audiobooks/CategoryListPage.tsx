import { useEffect, useState } from "react";
import { Shapes } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { MessageBox } from "../../shared/MessageBox";
import { SectionNav } from "../../shared/SectionNav";
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
  const section = sectionFromQuery();

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load categories"));
  }, []);

  const term = search.trim().toLowerCase();
  const shown = term ? categories.filter((category) => category.name.toLowerCase().includes(term)) : categories;

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
