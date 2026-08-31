import { useTranslation } from "react-i18next";
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
// Labels come from the theme.* locale keys ("System" is the one that localizes;
// the named themes are product names and stay as they are in every language).
const THEMES: { value: Theme; labelKey: "system" | "plainLight" | "plainDark" | "minimalist" | "light" | "dark"; palette?: Palette }[] = [
  { value: "system", labelKey: "system" },
  { value: "plain-light", labelKey: "plainLight", palette: { canvas: "#f3f6fb", surface: "#ffffff", ink: "#1f2937", mint: "#2563eb", muted: "#64748b" } },
  { value: "plain-dark", labelKey: "plainDark", palette: { canvas: "#04080c", surface: "#141f27", ink: "#edf2f4", mint: "#45bed2", muted: "#9fa9ad" } },
  { value: "minimalist", labelKey: "minimalist", palette: { canvas: "#e2e2df", surface: "#ffffff", ink: "#1d1d1f", mint: "#1d1d1f", muted: "#58585c" } },
  { value: "light", labelKey: "light", palette: { canvas: "#eef1e7", surface: "#fff9ee", ink: "#17292b", mint: "#3f716a", muted: "#68736b" } },
  { value: "dark", labelKey: "dark", palette: { canvas: "#020b0e", surface: "#07191d", ink: "#f2d9ad", mint: "#d14b2d", muted: "#b78f5d" } }
];

function Preview({ palette }: { palette?: Palette }) {
  // "System" (no palette): a split swatch hinting it follows the device.
  if (!palette) {
    return (
      <span className="theme-preview theme-preview-system" aria-hidden="true">
        <span className="theme-preview-side" style={{ background: "rgba(140,140,150,0.28)" }} />
        <span className="theme-preview-bar" style={{ background: "rgba(140,140,150,0.6)" }} />
        <span className="theme-preview-bar short" style={{ background: "rgba(140,140,150,0.45)" }} />
        <span className="theme-preview-dot" style={{ background: "#9bbcaf" }} />
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
  const { t } = useTranslation();
  return (
    <div className="theme-grid" role="radiogroup" aria-label={t("theme.label")}>
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
              <span>{t(`theme.${theme.labelKey}`)}</span>
              {selected && <Check className="theme-card-check" size={16} aria-hidden="true" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
