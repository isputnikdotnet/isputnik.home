import { Check } from "lucide-react";
import type { PublicUser } from "../api";

export type Theme = PublicUser["theme"];

interface Palette {
  canvas: string;
  surface: string;
  ink: string;
  mint: string;
  muted: string;
}

// Palettes mirror styles/tokens.css so each card previews the real theme colors.
const THEMES: { value: Theme; label: string; palette?: Palette }[] = [
  { value: "system", label: "System" },
  { value: "plain-light", label: "Plain Light", palette: { canvas: "#f3f6fb", surface: "#ffffff", ink: "#1f2937", mint: "#2563eb", muted: "#64748b" } },
  { value: "plain-dark", label: "Plain Dark", palette: { canvas: "#111827", surface: "#1f2937", ink: "#f2f5f8", mint: "#60a5fa", muted: "#a8b3c0" } },
  { value: "light", label: "iSputnik Light", palette: { canvas: "#f7f0df", surface: "#fffaf0", ink: "#0f2238", mint: "#2d746f", muted: "#596c6d" } },
  { value: "dark", label: "iSputnik Night", palette: { canvas: "#0f2238", surface: "#183a54", ink: "#f6f4ee", mint: "#8ed4c6", muted: "#c2cfca" } }
];

function Preview({ palette }: { palette?: Palette }) {
  // "System" (no palette): a split swatch hinting it follows the device.
  if (!palette) {
    return (
      <span className="theme-preview theme-preview-system" aria-hidden="true">
        <span className="theme-preview-side" style={{ background: "rgba(140,140,150,0.28)" }} />
        <span className="theme-preview-bar" style={{ background: "rgba(140,140,150,0.6)" }} />
        <span className="theme-preview-bar short" style={{ background: "rgba(140,140,150,0.45)" }} />
        <span className="theme-preview-dot" style={{ background: "#8ed4c6" }} />
      </span>
    );
  }
  return (
    <span className="theme-preview" style={{ background: palette.canvas }} aria-hidden="true">
      <span className="theme-preview-side" style={{ background: palette.surface }} />
      <span className="theme-preview-bar" style={{ background: palette.ink }} />
      <span className="theme-preview-bar short" style={{ background: palette.muted }} />
      <span className="theme-preview-dot" style={{ background: palette.mint }} />
    </span>
  );
}

export function ThemePicker({
  value,
  onChange,
  disabled
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
  disabled?: boolean;
}) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme) => {
        const selected = value === theme.value;
        return (
          <button
            key={theme.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-card${selected ? " selected" : ""}`}
            onClick={() => onChange(theme.value)}
            disabled={disabled}
          >
            <Preview palette={theme.palette} />
            <span className="theme-card-label">
              <span>{theme.label}</span>
              {selected && <Check className="theme-card-check" size={16} aria-hidden="true" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
