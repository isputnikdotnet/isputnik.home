import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";

// Numbered pagination: first and last page are always reachable, with a window
// around the current one and an ellipsis for the pages that are skipped. Used by
// every paged list in the control panel and the duplicate-photos review.

function pageWindow(page: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const out: (number | "gap")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(total - 1, page + 1);
  if (start > 2) out.push("gap");
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < total - 1) out.push("gap");
  out.push(total);
  return out;
}

export function Pager({
  page,
  totalPages,
  onChange,
  label
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  // One page needs no controls — rendering them would just be dead furniture.
  if (totalPages <= 1) return null;

  return (
    <nav className="pager" aria-label={label ?? t("pager.label")}>
      <div className="pager-pages">
        <Button
          variant="icon"
          className="pager-step"
          disabled={page === 1}
          aria-label={t("pager.previous")}
          title={t("pager.previous")}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </Button>

        {pageWindow(page, totalPages).map((entry, index) =>
          entry === "gap" ? (
            <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">…</span>
          ) : (
            <Button
              key={entry}
              variant={entry === page ? "primary" : "secondary"}
              className="pager-page"
              aria-label={t("pager.page", { page: entry })}
              aria-current={entry === page ? "page" : undefined}
              onClick={() => onChange(entry)}
            >
              {entry}
            </Button>
          )
        )}

        <Button
          variant="icon"
          className="pager-step"
          disabled={page === totalPages}
          aria-label={t("pager.next")}
          title={t("pager.next")}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>

      <span className="pager-status">{t("pager.status", { page, total: totalPages })}</span>
    </nav>
  );
}
