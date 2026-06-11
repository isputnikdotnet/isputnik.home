import { useState } from "react";
import { File, Folder, GripVertical, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ScanSource, MetadataSourceInfo } from "../../audiobooks/types";

const SOURCE_ICONS: Record<string, LucideIcon> = {
  file_metadata: File,
  metadata_files: Folder,
  folder_structure: Layers
};

// Ordered metadata-source list: position = priority (top wins per field), checkbox =
// enabled. Drag the grip handle to reorder. Labels/descriptions/recommended come
// from the server registry via /api/library/settings.
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

  const handleDragStart = (index: number) => setDragIndex(index);

  const handleDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    if (dragIndex !== null && dragOverIndex !== index) setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) return;
    const next = [...sources];
    const [item] = next.splice(dragIndex, 1);
    next.splice(index, 0, item);
    onChange(next);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="field">
      <p className="scan-sources-hint">Select items to scan. Drag to change the order in which they are processed.</p>
      <div className="scan-source-table">
        {sources.map((source, index) => {
          const info = infoById.get(source.id);
          const Icon = SOURCE_ICONS[source.id] ?? File;
          const isDragging = dragIndex === index;
          const isOver = dragOverIndex === index && dragIndex !== index;
          return (
            <div
              key={source.id}
              className={`scan-source-row${source.enabled ? "" : " disabled"}${isDragging ? " scan-source-dragging" : ""}${isOver ? " scan-source-drag-over" : ""}`}
              draggable
              onDragStart={() => handleDragStart(index)}
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
                aria-label={`Enable ${info?.label ?? source.id}`}
              />
              <span className="scan-source-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span className="scan-source-copy">
                <span className="scan-source-title-row">
                  <strong>{info?.label ?? source.id}</strong>
                  {info?.recommended && <span className="scan-source-badge">Recommended</span>}
                </span>
                <small>{info?.description ?? ""}</small>
              </span>
              <span className="scan-source-grip" aria-hidden="true">
                <GripVertical size={18} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
