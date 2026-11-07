import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

// The part of a Storage block that only matters once in a while — System data's
// database, thumbnails, backups and metadata, App storage's four parts — folded
// under one line (4.73). Each block now leads with its folder, its free space and
// one Change; the rows are a click away. `attention` opens it: a move running or
// failed, or a part with a problem, is never folded out of sight.
export function StorageFold({
  summary,
  attention,
  children
}: {
  summary: ReactNode;
  attention: boolean;
  children: ReactNode;
}) {
  return (
    // `key` remounts it when attention appears, so an open fold is what shows then
    // even if it had been closed by hand.
    <details key={attention ? "attention" : "quiet"} className="storage-fold" open={attention || undefined}>
      <summary>
        <ChevronRight size={15} aria-hidden="true" className="storage-fold-chevron" />
        <span>{summary}</span>
      </summary>
      {children}
    </details>
  );
}
