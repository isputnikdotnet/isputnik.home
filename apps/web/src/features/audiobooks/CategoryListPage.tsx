import { useEffect, useState } from "react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { SectionNav } from "../../shared/SectionNav";
import { AudiobookPageHeader } from "./AudiobooksPage";
import { CategoryIcon, categoryTint } from "./categoryIcons";
import { sectionFromQuery } from "./sectionNavItems";
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
  const section = sectionFromQuery();

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load categories"));
  }, []);

  return (
    <DashboardShell
      active={section?.active ?? "categories"}
      user={user}
      logout={logout}
      sideNav={section && (
        <SectionNav
          ariaLabel={section.active === "ebooks" ? "Ebooks" : "Audiobooks"}
          groupLabel={section.active === "ebooks" ? "Ebooks" : "Audiobooks"}
          items={section.items}
          activeKey="categories"
        />
      )}
    >
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Categories"
          subtitle={`${categories.length} ${categories.length === 1 ? "category" : "categories"}`}
        />

        {error && <MessageBox tone="error" title="Categories error">{error}</MessageBox>}

        <div className="category-grid">
          {categories.map((category) => (
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
      </section>
    </DashboardShell>
  );
}
