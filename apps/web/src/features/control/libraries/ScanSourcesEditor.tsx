import { ChevronUp, ChevronDown } from "lucide-react";
import type { ScanSource, MetadataSourceInfo } from "../../audiobooks/types";

// Ordered metadata-source list: position = priority (top wins per field), checkbox =
// enabled. Labels/descriptions come from the server registry via /api/library/settings.
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
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= sources.length) return;
    const next = [...sources];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="field">
      <span>Metadata sources (top has priority)</span>
      <div className="scan-source-list">
        {sources.map((source, index) => {
          const info = infoById.get(source.id);
          return (
            <div className={`scan-source-row${source.enabled ? "" : " disabled"}`} key={source.id}>
              <label className="scan-source-toggle">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  onChange={(event) =>
                    onChange(sources.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item)))}
                />
                <span className="scan-source-copy">
                  <strong>{info?.label ?? source.id}</strong>
                  <small>
                    {info?.description ?? ""}
                    {info?.affectsGrouping ? " Changes how files are grouped into books." : ""}
                  </small>
                </span>
              </label>
              <span className="scan-source-order">
                <button type="button" aria-label="Move up" onClick={() => move(index, -1)} disabled={index === 0}>
                  <ChevronUp size={14} />
                </button>
                <button type="button" aria-label="Move down" onClick={() => move(index, 1)} disabled={index === sources.length - 1}>
                  <ChevronDown size={14} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
