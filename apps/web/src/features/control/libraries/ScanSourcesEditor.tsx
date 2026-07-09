import { useState } from "react";
import { ChevronDown, ChevronUp, File, Files, Folder, GripVertical, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../../shared/Button";
import type { ScanSource, MetadataSourceInfo } from "../../audiobooks/types";

const SOURCE_ICONS: Record<string, LucideIcon> = {
  file_metadata: File,
  metadata_files: Folder,
  folder_structure: Layers,
  single_file: Files
};

// Ordered metadata-source list: position = priority (top wins per field), checkbox =
// enabled. Reorder by dragging the grip (mouse) or the up/down buttons (keyboard and
// touch — HTML5 drag fires on neither). Labels/descriptions/recommended come from the
// server registry via /api/library/settings.
export function ScanSourcesEditor({
  sources,
  onChange,
  sourceInfo
}: {
  sources: ScanSource[];
  onChange: (sources: ScanSource[]) => void;
  sourceInfo: MetadataSourceInfo[];
}) {
  const infoById = new Map(sourceInfo.map((info) => [info.id, info]));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= sources.length) return;
    const next = [...sources];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const handleDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    if (dragIndex !== null && dragOverIndex !== index) setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragIndex !== null) reorder(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="field">
      <p className="scan-sources-hint">Select items to scan. Drag the handle or use the arrows to change the order in which they are processed.</p>
      <div className="scan-source-table">
        {sources.map((source, index) => {
          const info = infoById.get(source.id);
          const Icon = SOURCE_ICONS[source.id] ?? File;
          const isDragging = dragIndex === index;
          const isOver = dragOverIndex === index && dragIndex !== index;
          const label = info?.label ?? source.id;
          return (
            <div
              key={source.id}
              className={`scan-source-row${source.enabled ? "" : " disabled"}${isDragging ? " scan-source-dragging" : ""}${isOver ? " scan-source-drag-over" : ""}`}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
            >
              <input
                type="checkbox"
                className="scan-source-check"
                checked={source.enabled}
                onChange={(event) =>
                  onChange(sources.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item)))}
                aria-label={`Enable ${label}`}
              />
              <span className="scan-source-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span className="scan-source-copy">
                <span className="scan-source-title-row">
                  <strong>{label}</strong>
                  {info?.recommended && <span className="scan-source-badge">Recommended</span>}
                </span>
                <small>{info?.description ?? ""}</small>
              </span>
              <span className="scan-source-actions">
                <Button
                  variant="icon"
                  compact
                  type="button"
                  className="scan-source-move"
                  disabled={index === 0}
                  aria-label={`Move ${label} up`}
                  title="Move up"
                  onClick={() => reorder(index, index - 1)}
                >
                  <ChevronUp size={16} />
                </Button>
                <Button
                  variant="icon"
                  compact
                  type="button"
                  className="scan-source-move"
                  disabled={index === sources.length - 1}
                  aria-label={`Move ${label} down`}
                  title="Move down"
                  onClick={() => reorder(index, index + 1)}
                >
                  <ChevronDown size={16} />
                </Button>
                <span
                  className="scan-source-grip"
                  aria-hidden="true"
                  title="Drag to reorder"
                  draggable
                  onDragStart={() => setDragIndex(index)}
                >
                  <GripVertical size={18} />
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
