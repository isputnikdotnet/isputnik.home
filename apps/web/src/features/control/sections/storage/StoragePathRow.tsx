import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

// One row of the Storage page: what it is, the folder it uses (with what is worth
// knowing under it — free space, a count, a problem), and one compact button on the
// right. Every row on the page has this shape, so a Change, a Manage and a Set up all
// sit in the same place; a problem is a line under the path, never a different path.

export function StoragePathRow({ id, label, sub, path, detail, warn, action }: {
  /** An anchor, so control-panel search can land on the row. */
  id?: string;
  label: ReactNode;
  /** A short line under the label ("Made here for each member"). */
  sub?: ReactNode;
  /** The folder — usually a <code> path; plain words when there is none. */
  path: ReactNode;
  /** Under the path: free space, a size. */
  detail?: ReactNode;
  /** Under the path, in amber: what needs a look. */
  warn?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="storage-path-row" id={id}>
      <div className="storage-path-label">
        <strong>{label}</strong>
        {sub && <small>{sub}</small>}
      </div>
      <div className="storage-path">
        {path}
        {detail && <small>{detail}</small>}
        {warn && <small className="is-warn"><AlertTriangle size={13} aria-hidden="true" /> {warn}</small>}
      </div>
      <div className="storage-path-action">{action}</div>
    </div>
  );
}
