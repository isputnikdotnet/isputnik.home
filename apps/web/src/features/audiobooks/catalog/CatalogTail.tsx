import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";

// Bottom-of-grid loader: an IntersectionObserver sentinel for infinite scroll
// plus an explicit "Load more" button as a fallback.
export function CatalogTail({
  hasMore, loadingMore, loadMore, sentinelRef
}: {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation(["common", "book"]);
  if (!hasMore) return null;
  return (
    <div className="audiobook-load-more" ref={sentinelRef}>
      <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? t("book:detail.loading") : t("book:catalog.loadMore")}
      </Button>
    </div>
  );
}
