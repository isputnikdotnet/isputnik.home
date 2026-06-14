import { useEffect, useState } from "react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "./AudiobooksPage";
import { CategoryIcon } from "./categoryIcons";
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

  useEffect(() => {
    api<{ categories: CategorySummary[] }>("/api/library/categories")
      .then((payload) => setCategories(payload.categories))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load categories"));
  }, []);

  return (
    <DashboardShell active="categories" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Categories"
          subtitle={`${categories.length} ${categories.length === 1 ? "category" : "categories"}`}
        />

        {error && <MessageBox tone="error" title="Categories error">{error}</MessageBox>}

        <div className="series-grid">
          {categories.map((category) => (
            <button
              key={category.key}
              className="series-card"
              onClick={() => navigate(`/categories/${category.key}`)}
            >
              <div className="series-card-cover category-card-cover" aria-hidden="true">
                {category.imageUrl ? (
                  <img src={category.imageUrl} alt="" />
                ) : (
                  <CategoryIcon icon={category.icon} size={30} />
                )}
              </div>
              <div className="series-card-body">
                <strong>{category.name}</strong>
                <span>{category.bookCount} {category.bookCount === 1 ? "book" : "books"}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}
