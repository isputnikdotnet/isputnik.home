import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { ALPHABETS, OTHER_BUCKET, alphabetOf, type AlphabetId } from "./alphabets";
import { cx } from "./cx";
import { useAnchoredMenu } from "./useAnchoredMenu";

// The A–Z index of a browse page, in two shapes over one state:
//
//   * AlphabetMenu — the "A–Z" control in LibraryPageToolbar's tools, opening a
//     grid of letters. The default above the phone breakpoint: a whole row of
//     thirty-odd letters cost a line of the first screen for something used now
//     and then.
//   * AlphabetBar — the strip in the toolbar's second row. Phones always get it
//     (on a screen of six books it is the fastest way down a long shelf); wider
//     screens get it back when someone asks for it from the menu, a per-browser
//     choice (useAlphabetStrip).
//
// One letter at a time, "All" to clear it, "#" for everything that isn't a
// letter of any alphabet this build has a strip for (digits, symbols, other
// scripts) — the server's bucket, the same whichever row is showing.
//
// `available` is the set of buckets the current scope actually holds, straight
// from the server's facets. Letters outside it are disabled rather than hidden:
// a row that reflowed as the scope changed would move the letter out from under
// the pointer.
//
// The script toggle (English | Русский) appears only when the scope has titles
// in both — a library with nothing but Latin titles gets the letters alone.
export interface AlphabetProps {
  available: string[];
  value: string | null;
  onChange: (letter: string | null) => void;
  ariaLabel?: string;
}

function useAlphabet({ available, value, onChange }: AlphabetProps) {
  const has = useMemo(() => new Set(available), [available]);
  const scripts = useMemo(
    () => ALPHABETS.filter((alphabet) => alphabet.letters.some((letter) => has.has(letter))),
    [has]
  );
  const [picked, setPicked] = useState<AlphabetId | null>(null);

  // A chosen letter always wins: landing on ?letter=Д has to show the Cyrillic
  // row whatever the toggle last said.
  const fromValue = value ? alphabetOf(value)?.id ?? null : null;
  const active = ALPHABETS.find((alphabet) => alphabet.id === (fromValue ?? picked)) ?? scripts[0];

  const pickScript = (id: AlphabetId) => {
    setPicked(id);
    // A letter of the alphabet being left can't stay. "#" can: both rows end in
    // it, and it means the same titles under either.
    if (value && value !== OTHER_BUCKET && !ALPHABETS.find((alphabet) => alphabet.id === id)?.letters.includes(value)) onChange(null);
  };

  // Nothing indexed yet (an empty or still-scanning library): no index at all.
  const empty = !active || available.length === 0;
  return { has, scripts, active, pickScript, empty };
}

function Letters({ props, state, onPicked }: {
  props: AlphabetProps;
  state: ReturnType<typeof useAlphabet>;
  onPicked?: () => void;
}) {
  const { t } = useTranslation();
  const { value, onChange } = props;
  const { has, scripts, active, pickScript } = state;
  if (!active) return null;

  const pick = (letter: string | null) => { onChange(letter); onPicked?.(); };
  const letterButton = (letter: string, label?: string) => (
    <button
      key={letter}
      type="button"
      className={value === letter ? "is-active" : ""}
      disabled={!has.has(letter)}
      aria-pressed={value === letter}
      aria-label={label}
      onClick={() => pick(value === letter ? null : letter)}
    >
      {letter}
    </button>
  );

  return (
    <>
      {scripts.length > 1 && (
        <div className="alphabet-scripts" role="group" aria-label={t("alphabet.scripts")}>
          {scripts.map((alphabet) => (
            <button
              key={alphabet.id}
              type="button"
              className={active.id === alphabet.id ? "is-active" : ""}
              aria-pressed={active.id === alphabet.id}
              aria-label={alphabet.label}
              title={alphabet.label}
              onClick={() => pickScript(alphabet.id)}
            >
              {alphabet.short}
            </button>
          ))}
        </div>
      )}
      <div className="alphabet-letters">
        <button
          type="button"
          className={cx("alphabet-all", value === null && "is-active")}
          aria-pressed={value === null}
          onClick={() => pick(null)}
        >
          {t("alphabet.all")}
        </button>
        {active.letters.map((letter) => letterButton(letter))}
        {letterButton(OTHER_BUCKET, t("alphabet.other"))}
      </div>
    </>
  );
}

export function AlphabetBar(props: AlphabetProps) {
  const { t } = useTranslation();
  const state = useAlphabet(props);
  if (state.empty) return null;
  return (
    <div className="alphabet-bar" role="group" aria-label={props.ariaLabel ?? t("alphabet.label")}>
      <Letters props={props} state={state} />
    </div>
  );
}

export function AlphabetMenu(props: AlphabetProps & { strip: boolean; onStripChange: (strip: boolean) => void }) {
  const { t } = useTranslation();
  const state = useAlphabet(props);
  const { open, pos, toggle, close, triggerRef, menuRef } = useAnchoredMenu({ menuWidth: 300 });
  const label = props.ariaLabel ?? t("alphabet.label");

  // Focus lands on the current choice, so a keyboard user starts where they are.
  useEffect(() => {
    if (!open || !pos) return;
    menuRef.current?.querySelector<HTMLButtonElement>(".alphabet-letters button.is-active")?.focus();
  }, [open, pos, menuRef]);

  if (state.empty) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx("library-toolbar-button", "alphabet-menu-trigger", props.value !== null && "is-filtered")}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={props.value ? `${label}: ${props.value}` : label}
        title={props.value ? `${label}: ${props.value}` : label}
      >
        <span className="alphabet-menu-glyph" aria-hidden="true">{props.value ?? t("alphabet.short")}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="alphabet-menu"
          role="dialog"
          aria-label={label}
          style={{ position: "fixed", top: pos.top, left: pos.left ?? undefined, right: pos.right ?? undefined }}
        >
          <div className="alphabet-bar is-grid" role="group" aria-label={label}>
            <Letters props={props} state={state} onPicked={close} />
          </div>
          <button
            type="button"
            className="alphabet-menu-strip"
            aria-pressed={props.strip}
            onClick={() => { props.onStripChange(!props.strip); close(); }}
          >
            {props.strip ? t("alphabet.hideStrip") : t("alphabet.showStrip")}
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

// Whether a wide screen shows the strip as well as the menu. Per browser, like
// the layout choice: it is how this screen is used, not a setting of the account.
const STRIP_KEY = "isputnik.alphabetStrip";
const listeners = new Set<() => void>();
// What this page last chose, so the toggle still works where storage throws.
let chosen: boolean | null = null;

function readStrip(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(STRIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function useAlphabetStrip(): [boolean, (strip: boolean) => void] {
  const strip = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readStrip,
    () => false
  );
  const setStrip = (next: boolean) => {
    chosen = next;
    try {
      if (next) localStorage.setItem(STRIP_KEY, "1");
      else localStorage.removeItem(STRIP_KEY);
    } catch {
      // Private mode: the choice lasts as long as the page.
    }
    listeners.forEach((listener) => listener());
  };
  return [strip, setStrip];
}
