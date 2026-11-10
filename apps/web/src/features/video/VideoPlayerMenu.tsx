import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../shared/Button";
import { useMenuKeyboard } from "../../shared/useMenuKeyboard";

/** One thing to choose in a player menu: the quality, the sound track, the speed. */
export interface PlayerMenuSection {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** Something a player menu does: Start over, Mark intro. */
export interface PlayerMenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

// A menu of the player's control bar: an icon that opens a small dark sheet over
// the picture. A `single` one is its one section's choices at once (Subtitles);
// the others list their sections with what each is set to, each opening its own
// choices (Settings: Quality, Sound, Speed). Dark whatever the theme, like the rest
// of the bar. The keyboard is useMenuKeyboard's, the same as every other menu.
export function VideoPlayerMenu({ label, icon, sections = [], actions = [], single = false }: {
  label: string;
  icon: ReactNode;
  sections?: PlayerMenuSection[];
  actions?: PlayerMenuAction[];
  /** The menu IS its first section: no list to choose it from. */
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** The section whose choices show; null for the list of sections. */
  const [page, setPage] = useState<string | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keys = useMenuKeyboard({ open, close: () => setOpen(false), menuRef: menu, triggerRef: trigger });

  const only = single ? sections[0] ?? null : null;
  const shown = only ?? sections.find((section) => section.id === page) ?? null;
  const labelOf = (section: PlayerMenuSection) => section.options.find((option) => option.value === section.value)?.label ?? "";

  useEffect(() => {
    if (!open) {
      setPage(null);
      return;
    }
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  // Into a section, or back out of one: focus follows, as it does on opening.
  useEffect(() => {
    if (!open) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });
  }, [open, page]);

  if (sections.length === 0 && actions.length === 0) return null;

  return (
    <div ref={root} className="video-player-menu">
      <Button
        ref={trigger}
        variant="bare"
        className="video-player-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={only ? `${label}: ${labelOf(only)}` : label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
      </Button>

      {open && (
        <div
          id={menuId}
          ref={menu}
          className="video-player-menu-sheet"
          role="menu"
          aria-label={shown ? shown.label : label}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && shown && !only) {
              event.preventDefault();
              setPage(null);
              return;
            }
            keys.onKeyDown(event);
          }}
        >
          {shown ? (
            <>
              {only ? (
                <div className="video-player-menu-title">{shown.label}</div>
              ) : (
                <Button variant="bare" className="video-player-menu-item is-back" role="menuitem" onClick={() => setPage(null)}>
                  <ChevronLeft size={18} aria-hidden="true" />
                  <span>{shown.label}</span>
                </Button>
              )}
              {shown.options.map((option) => {
                const checked = option.value === shown.value;
                return (
                  <Button
                    key={option.value}
                    variant="bare"
                    className="video-player-menu-item"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={() => {
                      shown.onChange(option.value);
                      keys.closeAndRestore();
                    }}
                  >
                    <span className="video-player-menu-check" aria-hidden="true">{checked && <Check size={16} />}</span>
                    <span>{option.label}</span>
                  </Button>
                );
              })}
            </>
          ) : (
            <>
              {sections.map((section) => (
                <Button
                  key={section.id}
                  variant="bare"
                  className="video-player-menu-item is-section"
                  role="menuitem"
                  aria-label={`${section.label}: ${labelOf(section)}`}
                  onClick={() => setPage(section.id)}
                >
                  <span>{section.label}</span>
                  <span className="video-player-menu-value">{labelOf(section)}</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </Button>
              ))}
              {actions.map((action) => (
                <Button
                  key={action.id}
                  variant="bare"
                  className="video-player-menu-item"
                  role="menuitem"
                  onClick={() => {
                    keys.closeAndRestore();
                    action.onSelect();
                  }}
                >
                  <span className="video-player-menu-check" aria-hidden="true">{action.icon}</span>
                  <span>{action.label}</span>
                </Button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
